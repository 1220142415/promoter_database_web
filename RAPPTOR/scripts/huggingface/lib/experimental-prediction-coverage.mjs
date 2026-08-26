import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const ACCESSION = /^GC[AF]_\d{9}\.\d+$/;
const SHA256 = /^(?:sha256:)?([0-9a-f]{64})$/i;
const ACCESSION_COLUMNS = new Set(['accession', 'assembly_accession', 'genome_accession', 'gcf', 'gca']);
const CHECKSUM_COLUMNS = ['reference_sequence_sha256', 'reference_sha256', 'fasta_sha256'];
const FAI_COLUMNS = ['fai_path', 'reference_fai', 'fasta_fai'];
const REFERENCE_COLUMNS = ['reference_path', 'fasta_path'];
const ALIAS_FIELDS = [
  'genbankAssemblyAccession', 'genbank_assembly_accession',
  'refseqAssemblyAccession', 'refseq_assembly_accession',
  'pairedAssemblyAccession', 'paired_assembly_accession',
];

export const COVERAGE_CLASSIFICATIONS = Object.freeze([
  'exact_compatible',
  'reciprocal_gca_gcf_candidate',
  'prediction_missing',
  'reference_mismatch',
  'metadata_incomplete',
]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function splitTsv(text, label) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) throw new Error(`${label} is empty`);
  const header = lines.shift().split('\t');
  if (header.some((field) => !field || /[\u0000-\u001f\u007f]/.test(field))) {
    throw new Error(`${label} has an invalid TSV header`);
  }
  const rows = lines.map((line, offset) => {
    const fields = line.split('\t');
    if (fields.length !== header.length) throw new Error(`${label} row ${offset + 2} has ${fields.length} columns; expected ${header.length}`);
    return Object.fromEntries(header.map((field, index) => [field, fields[index]]));
  });
  return { header, rows };
}

export function assertAssemblyAccession(value, label = 'assembly accession') {
  if (typeof value !== 'string' || !ACCESSION.test(value)) throw new Error(`invalid ${label}: ${String(value)}`);
  return value;
}

export function safeRelativeAssetPath(value, label = 'asset path') {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid ${label}: ${String(value)}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`unsafe ${label}: ${value}`);
  return value;
}

function normalizeSha256(value, label) {
  if (value == null || value === '') return null;
  const match = String(value).match(SHA256);
  if (!match) throw new Error(`invalid ${label}`);
  return match[1].toLowerCase();
}

function addAlias(entry, value, label) {
  if (value == null || value === '') return;
  const alias = assertAssemblyAccession(value, label);
  if (alias !== entry.accession) entry.aliases.add(alias);
}

function readNestedAliasValues(genome) {
  const values = [];
  for (const field of ALIAS_FIELDS) values.push([genome[field], field]);
  values.push([genome.pairedAssembly?.accession, 'pairedAssembly.accession']);
  values.push([genome.paired_assembly?.accession, 'paired_assembly.accession']);
  values.push([genome.assemblyInfo?.pairedAssembly?.accession, 'assemblyInfo.pairedAssembly.accession']);
  return values;
}

function newEntry(accession, source) {
  return {
    accession,
    aliases: new Set(),
    checksums: new Set(),
    contigDictionaries: new Map(),
    sources: new Set([source]),
    studies: new Set(),
    issues: new Set(),
    catalogMetadata: false,
    manifestMetadata: false,
  };
}

function mergeEntry(target, source) {
  for (const key of ['aliases', 'checksums', 'sources', 'studies', 'issues']) {
    for (const value of source[key]) target[key].add(value);
  }
  for (const [signature, dictionary] of source.contigDictionaries) target.contigDictionaries.set(signature, dictionary);
  target.catalogMetadata ||= source.catalogMetadata;
  target.manifestMetadata ||= source.manifestMetadata;
  if (target.checksums.size > 1) target.issues.add('conflicting_reference_checksums');
  if (target.contigDictionaries.size > 1) target.issues.add('conflicting_contig_dictionaries');
  return target;
}

function normalizeContigDictionary(value, label) {
  if (value == null) return null;
  let rows;
  if (Array.isArray(value)) {
    rows = value.map((item) => {
      if (Array.isArray(item)) return [item[0], item[1]];
      if (item && typeof item === 'object') return [item.name ?? item.refName ?? item.sequence, item.length ?? item.end];
      throw new Error(`${label} contains an invalid contig row`);
    });
  } else if (typeof value === 'object') {
    rows = Object.entries(value);
  } else {
    throw new Error(`${label} must be an array or object`);
  }
  const dictionary = new Map();
  for (const [rawName, rawLength] of rows) {
    const name = String(rawName ?? '');
    const length = Number(rawLength);
    if (!name || /\s|[\u0000-\u001f\u007f]/.test(name) || !Number.isSafeInteger(length) || length < 1) {
      throw new Error(`${label} contains an invalid contig`);
    }
    if (dictionary.has(name)) throw new Error(`${label} contains duplicate contig ${name}`);
    dictionary.set(name, length);
  }
  if (!dictionary.size) throw new Error(`${label} is empty`);
  return dictionary;
}

export function parseFaiDictionary(text, label = 'FAI') {
  const rows = text.split(/\r?\n/).filter(Boolean).map((line, offset) => {
    const fields = line.split('\t');
    if (fields.length < 2) throw new Error(`${label} row ${offset + 1} has fewer than two columns`);
    return [fields[0], fields[1]];
  });
  return normalizeContigDictionary(rows, label);
}

function dictionarySignature(dictionary) {
  return [...dictionary.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, length]) => `${name}\t${length}`).join('\n');
}

function addDictionary(entry, dictionary) {
  if (!dictionary) return;
  entry.contigDictionaries.set(dictionarySignature(dictionary), dictionary);
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function resolveCatalogAsset(catalogPath, rawPath) {
  if (!rawPath) return null;
  const relativePath = safeRelativeAssetPath(rawPath, 'catalog reference asset path');
  const root = dirname(resolve(catalogPath));
  for (const candidate of [join(root, ...relativePath.split('/')), join(root, 'objects', ...relativePath.split('/'))]) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function catalogReferenceChecksum(genome) {
  const values = [
    genome.referenceSequenceSha256,
    genome.reference_sequence_sha256,
    genome.referenceStorage?.checksums?.fasta,
    genome.checksums?.fasta,
  ].filter((value) => value != null && value !== '');
  return values.map((value, index) => normalizeSha256(value, `${genome.accession} reference checksum ${index + 1}`));
}

function catalogInlineDictionary(genome) {
  const value = genome.contigDictionary ?? genome.contig_dictionary ?? genome.sequenceLengths ?? genome.sequence_lengths;
  return value == null ? null : normalizeContigDictionary(value, `${genome.accession} contig dictionary`);
}

async function catalogEntry(genome, catalogPath, source) {
  if (!genome || typeof genome !== 'object') throw new Error(`${source} contains an invalid genome row`);
  const accession = assertAssemblyAccession(genome.accession, `${source} genome accession`);
  const entry = newEntry(accession, source);
  entry.catalogMetadata = true;
  for (const [value, label] of readNestedAliasValues(genome)) addAlias(entry, value, `${accession} ${label}`);
  for (const checksum of catalogReferenceChecksum(genome)) entry.checksums.add(checksum);
  addDictionary(entry, catalogInlineDictionary(genome));
  for (const [label, value] of Object.entries({
    'referenceStorage.files.fasta': genome.referenceStorage?.files?.fasta,
    'referenceStorage.files.fai': genome.referenceStorage?.files?.fai,
    'referenceStorage.files.gzi': genome.referenceStorage?.files?.gzi,
    'assets.fasta': genome.assets?.fasta,
    'assets.fastaFai': genome.assets?.fastaFai,
    'assets.fastaGzi': genome.assets?.fastaGzi,
  })) {
    if (value) safeRelativeAssetPath(value, `${accession} ${label}`);
  }
  const faiPath = genome.referenceStorage?.files?.fai ?? genome.assets?.fastaFai ?? genome.assets?.fai;
  if (faiPath) {
    const localFai = await resolveCatalogAsset(catalogPath, faiPath);
    if (localFai) addDictionary(entry, parseFaiDictionary(await readFile(localFai, 'utf8'), `${accession} FAI`));
  }
  for (const study of genome.studies || []) entry.studies.add(String(study));
  if (entry.checksums.size > 1) entry.issues.add('conflicting_reference_checksums');
  if (entry.contigDictionaries.size > 1) entry.issues.add('conflicting_contig_dictionaries');
  return entry;
}

export async function loadCatalogEntries(catalogPath, source = 'catalog') {
  const catalog = JSON.parse(await readFile(resolve(catalogPath), 'utf8'));
  if (!Array.isArray(catalog.genomes)) throw new Error(`${source} does not contain a genomes array`);
  const entries = new Map();
  for (const genome of catalog.genomes) {
    const entry = await catalogEntry(genome, catalogPath, source);
    if (entries.has(entry.accession)) throw new Error(`${source} contains duplicate accession ${entry.accession}`);
    entries.set(entry.accession, entry);
  }
  return entries;
}

export function parseExperimentalManifestText(text, label = 'experimental manifest') {
  const parsed = splitTsv(text, label);
  for (const required of ['study_id', 'gcf']) {
    if (!parsed.header.includes(required)) throw new Error(`${label} is missing ${required}`);
  }
  const entries = new Map();
  for (const [offset, row] of parsed.rows.entries()) {
    const accession = assertAssemblyAccession(row.gcf, `${label} row ${offset + 2} GCF accession`);
    if (!accession.startsWith('GCF_')) throw new Error(`${label} row ${offset + 2} is not a GCF accession`);
    if (!/^\d{4}_\d+_GCF_\d{9}\.\d+$/.test(row.study_id) || !row.study_id.endsWith(`_${accession}`)) {
      throw new Error(`${label} row ${offset + 2} has an invalid study_id`);
    }
    const entry = entries.get(accession) || newEntry(accession, 'experimental_manifest');
    entry.manifestMetadata = true;
    entry.studies.add(row.study_id);
    entries.set(accession, entry);
  }
  if (!entries.size) throw new Error(`${label} contains no genomes`);
  return entries;
}

function findHeaderIndex(header, candidates) {
  const lower = header.map((field) => field.toLowerCase());
  for (let index = 0; index < lower.length; index += 1) if (candidates.has(lower[index])) return index;
  return -1;
}

function accessionFromMappingRow(header, row, offset, label) {
  const values = header.map((field) => row[field]);
  const accessionIndex = findHeaderIndex(header, ACCESSION_COLUMNS);
  if (accessionIndex >= 0) return assertAssemblyAccession(values[accessionIndex], `${label} row ${offset + 2} accession`);
  const found = new Set();
  for (const value of values) {
    for (const token of String(value).match(/GC[AF]_\d{9}\.\d+/g) || []) found.add(token);
  }
  if (found.size !== 1) throw new Error(`${label} row ${offset + 2} must contain exactly one assembly accession`);
  return assertAssemblyAccession([...found][0], `${label} row ${offset + 2} accession`);
}

async function mappingEntry(header, row, offset, mappingPath, source) {
  const accession = accessionFromMappingRow(header, row, offset, source);
  const entry = newEntry(accession, source);
  const lowerRow = Object.fromEntries(header.map((field) => [field.toLowerCase(), row[field]]));
  for (const field of ALIAS_FIELDS.map((value) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))) {
    addAlias(entry, lowerRow[field], `${accession} ${field}`);
  }
  for (const field of CHECKSUM_COLUMNS) {
    const checksum = normalizeSha256(lowerRow[field], `${accession} ${field}`);
    if (checksum) entry.checksums.add(checksum);
  }
  for (const field of FAI_COLUMNS) {
    if (!lowerRow[field]) continue;
    const relativePath = safeRelativeAssetPath(lowerRow[field], `${accession} ${field}`);
    const localPath = join(dirname(resolve(mappingPath)), ...relativePath.split('/'));
    if (await exists(localPath)) addDictionary(entry, parseFaiDictionary(await readFile(localPath, 'utf8'), `${accession} FAI`));
  }
  for (const field of REFERENCE_COLUMNS) {
    if (!lowerRow[field]) continue;
    const relativePath = safeRelativeAssetPath(lowerRow[field], `${accession} ${field}`);
    const localPath = join(dirname(resolve(mappingPath)), ...relativePath.split('/'));
    if (await exists(localPath)) entry.checksums.add(await hashFile(localPath));
  }
  if (lowerRow.contig_dictionary) addDictionary(entry, normalizeContigDictionary(JSON.parse(lowerRow.contig_dictionary), `${accession} contig_dictionary`));
  if (entry.checksums.size > 1) entry.issues.add('conflicting_reference_checksums');
  if (entry.contigDictionaries.size > 1) entry.issues.add('conflicting_contig_dictionaries');
  return entry;
}

export async function loadHfInputMapping(mappingPath, source = 'hf_input_mapping') {
  const parsed = splitTsv(await readFile(resolve(mappingPath), 'utf8'), source);
  const entries = new Map();
  for (const [offset, row] of parsed.rows.entries()) {
    const entry = await mappingEntry(parsed.header, row, offset, mappingPath, source);
    if (entries.has(entry.accession)) throw new Error(`${source} contains duplicate accession ${entry.accession}`);
    entries.set(entry.accession, entry);
  }
  if (!entries.size) throw new Error(`${source} contains no genomes`);
  return entries;
}

export function mergeEntryMaps(maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const entry of map.values()) {
      if (merged.has(entry.accession)) mergeEntry(merged.get(entry.accession), entry);
      else merged.set(entry.accession, mergeEntry(newEntry(entry.accession, [...entry.sources][0]), entry));
    }
  }
  return merged;
}

function oppositeNamespaces(left, right) {
  return left.slice(0, 3) !== right.slice(0, 3);
}

function compareReferences(experimental, prediction) {
  const checksumComparable = experimental.checksums.size === 1 && prediction.checksums.size === 1;
  const contigComparable = experimental.contigDictionaries.size === 1 && prediction.contigDictionaries.size === 1;
  const checksumMatch = checksumComparable ? [...experimental.checksums][0] === [...prediction.checksums][0] : null;
  const contigMatch = contigComparable
    ? [...experimental.contigDictionaries.keys()][0] === [...prediction.contigDictionaries.keys()][0] : null;
  const mismatches = [];
  if (checksumMatch === false) mismatches.push('fasta_checksum');
  if (contigMatch === false) mismatches.push('contig_dictionary');
  let status = 'unavailable';
  if (mismatches.length) status = 'mismatch';
  else if (checksumMatch === true) status = 'verified';
  else if (contigMatch === true) status = 'structurally_compatible';
  return { status, checksumMatch, contigDictionaryMatch: contigMatch, mismatches };
}

function publicMetadata(entry) {
  const dictionary = entry.contigDictionaries.size === 1 ? [...entry.contigDictionaries.values()][0] : null;
  return {
    aliases: [...entry.aliases].sort(),
    fastaSha256: entry.checksums.size === 1 ? [...entry.checksums][0] : null,
    contigCount: dictionary?.size ?? null,
    metadataIssues: [...entry.issues].sort(),
    sources: [...entry.sources].sort(),
  };
}

function reciprocalCandidates(experimental, predictions) {
  return [...predictions.values()].filter((prediction) => oppositeNamespaces(experimental.accession, prediction.accession)
    && (experimental.aliases.has(prediction.accession) || prediction.aliases.has(experimental.accession)));
}

export function auditExperimentalPredictionCoverage(experimentalEntries, predictionEntries, options = {}) {
  const experimentalCatalogExpected = Boolean(options.experimentalCatalogExpected);
  const records = [];
  for (const accession of [...experimentalEntries.keys()].sort()) {
    const experimental = experimentalEntries.get(accession);
    let prediction = predictionEntries.get(accession) || null;
    let matchBasis = prediction ? 'exact_accession' : null;
    if (!prediction) {
      const candidates = reciprocalCandidates(experimental, predictionEntries);
      if (candidates.length === 1) {
        [prediction] = candidates;
        const fromExperimental = experimental.aliases.has(prediction.accession);
        const fromPrediction = prediction.aliases.has(experimental.accession);
        matchBasis = fromExperimental && fromPrediction ? 'reciprocal_explicit_metadata'
          : fromExperimental ? 'experimental_explicit_alias' : 'prediction_explicit_alias';
      } else if (candidates.length > 1) {
        experimental.issues.add('ambiguous_reciprocal_alias');
      }
    }
    const issues = new Set([...experimental.issues, ...(prediction?.issues || [])]);
    if (experimentalCatalogExpected && experimental.manifestMetadata && !experimental.catalogMetadata) {
      issues.add('missing_experimental_catalog_metadata');
    }
    const referenceComparison = prediction ? compareReferences(experimental, prediction) : {
      status: 'unavailable', checksumMatch: null, contigDictionaryMatch: null, mismatches: [],
    };
    let classification;
    if (issues.size) classification = 'metadata_incomplete';
    else if (!prediction) classification = 'prediction_missing';
    else if (referenceComparison.status === 'mismatch') classification = 'reference_mismatch';
    else if (matchBasis === 'exact_accession') classification = 'exact_compatible';
    else classification = 'reciprocal_gca_gcf_candidate';
    records.push({
      experimentalAccession: accession,
      predictionAccession: prediction?.accession || null,
      classification,
      matchBasis,
      studies: [...experimental.studies].sort(),
      referenceComparison,
      experimental: publicMetadata(experimental),
      prediction: prediction ? publicMetadata(prediction) : null,
      metadataIssues: [...issues].sort(),
    });
  }
  const summary = Object.fromEntries(COVERAGE_CLASSIFICATIONS.map((classification) => [
    classification,
    records.filter((record) => record.classification === classification).length,
  ]));
  return {
    schemaVersion: 1,
    summary: {
      experimentalGenomes: records.length,
      predictionGenomesScanned: predictionEntries.size,
      ...summary,
    },
    records,
  };
}

function tsvCell(value) {
  const text = value == null ? '' : String(value);
  if (/\t|\r|\n/.test(text)) throw new Error('coverage TSV value contains a control character');
  return text;
}

export function coverageAuditToTsv(audit) {
  const header = [
    'experimental_accession', 'prediction_accession', 'classification', 'match_basis',
    'reference_verification', 'checksum_match', 'contig_dictionary_match', 'studies', 'metadata_issues',
  ];
  const rows = audit.records.map((record) => [
    record.experimentalAccession,
    record.predictionAccession,
    record.classification,
    record.matchBasis,
    record.referenceComparison.status,
    record.referenceComparison.checksumMatch,
    record.referenceComparison.contigDictionaryMatch,
    record.studies.join(','),
    record.metadataIssues.join(','),
  ].map(tsvCell).join('\t'));
  return `${[header.join('\t'), ...rows].join('\n')}\n`;
}
