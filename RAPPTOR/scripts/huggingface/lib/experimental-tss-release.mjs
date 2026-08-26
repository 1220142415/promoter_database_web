import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createGunzip, gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';

const gzip = promisify(gzipCallback);

export const EXPERIMENTAL_TSS_BASELINE = Object.freeze({
  studies: 98,
  genomes: 90,
  publications: 78,
  observations: 440_947,
});

const MANIFEST_HEADER = [
  'study_id', 'dataset_row', 'gcf', 'pmid', 'source_file', 'source_sha256', 'output_file', 'record_count',
];
const ACCESSION = /^GCF_\d{9}\.\d+$/;
const STUDY_ID = /^\d{4}_\d+_GCF_\d{9}\.\d+$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function safeReleasePath(value, label = 'asset path') {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  const normalized = value.split('/');
  if (isAbsolute(value) || normalized.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} is unsafe: ${value}`);
  }
  return value;
}

function splitTsv(line) {
  return line.replace(/\r$/, '').split('\t');
}

export async function parseExperimentalManifest(sourceRoot, settings = {}) {
  const manifestPath = settings.manifestPath || join(sourceRoot, 'manifest.tsv');
  const lines = (await readFile(manifestPath, 'utf8')).split(/\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error('experimental manifest is empty');
  const header = splitTsv(lines.shift());
  if (header.length !== MANIFEST_HEADER.length || header.some((field, index) => field !== MANIFEST_HEADER[index])) {
    throw new Error(`unexpected experimental manifest header; expected ${MANIFEST_HEADER.join('\t')}`);
  }
  const rows = [];
  const studyIds = new Set();
  const datasetRows = new Set();
  const outputFiles = new Set();
  for (const [offset, line] of lines.entries()) {
    const fields = splitTsv(line);
    if (fields.length !== MANIFEST_HEADER.length) throw new Error(`manifest row ${offset + 2} does not have eight columns`);
    const value = Object.fromEntries(MANIFEST_HEADER.map((field, index) => [field, fields[index]]));
    const datasetRow = Number(value.dataset_row);
    const recordCount = Number(value.record_count);
    const year = Number(value.study_id.slice(0, 4));
    if (!STUDY_ID.test(value.study_id) || !value.study_id.endsWith(`_${value.gcf}`)) throw new Error(`invalid study_id at manifest row ${offset + 2}`);
    if (!ACCESSION.test(value.gcf)) throw new Error(`invalid GCF accession at manifest row ${offset + 2}`);
    if (!/^\d{7,9}$/.test(value.pmid)) throw new Error(`invalid PMID at manifest row ${offset + 2}`);
    if (!Number.isSafeInteger(datasetRow) || datasetRow < 1) throw new Error(`invalid dataset_row at manifest row ${offset + 2}`);
    if (!Number.isSafeInteger(recordCount) || recordCount < 1) throw new Error(`invalid record_count at manifest row ${offset + 2}`);
    if (!Number.isSafeInteger(year) || year < 1900 || year > 2200) throw new Error(`invalid year in study_id at manifest row ${offset + 2}`);
    if (!SAFE_FILE.test(value.source_file) || !value.source_file.endsWith('.bed')) throw new Error(`invalid source_file at manifest row ${offset + 2}`);
    if (!SAFE_FILE.test(value.output_file) || !value.output_file.endsWith('.bed')) throw new Error(`invalid output_file at manifest row ${offset + 2}`);
    if (!SHA256.test(value.source_sha256)) throw new Error(`invalid source_sha256 at manifest row ${offset + 2}`);
    if (studyIds.has(value.study_id)) throw new Error(`duplicate study_id: ${value.study_id}`);
    if (datasetRows.has(datasetRow)) throw new Error(`duplicate dataset_row: ${datasetRow}`);
    if (outputFiles.has(value.output_file)) throw new Error(`duplicate output_file: ${value.output_file}`);
    studyIds.add(value.study_id);
    datasetRows.add(datasetRow);
    outputFiles.add(value.output_file);
    rows.push({
      studyId: value.study_id,
      datasetRow,
      accession: value.gcf,
      pmid: value.pmid,
      year,
      sourceFile: value.source_file,
      sourceSha256: value.source_sha256,
      outputFile: value.output_file,
      recordCount,
    });
  }
  rows.sort((left, right) => left.datasetRow - right.datasetRow);
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].datasetRow !== index + 1) throw new Error(`dataset_row sequence is incomplete at ${index + 1}`);
  }
  const summary = {
    studies: rows.length,
    genomes: new Set(rows.map((row) => row.accession)).size,
    publications: new Set(rows.map((row) => row.pmid)).size,
    observations: rows.reduce((sum, row) => sum + row.recordCount, 0),
  };
  const expected = settings.expected === false ? null : settings.expected || EXPERIMENTAL_TSS_BASELINE;
  if (expected) {
    for (const key of Object.keys(EXPERIMENTAL_TSS_BASELINE)) {
      if (summary[key] !== expected[key]) throw new Error(`experimental manifest ${key} mismatch: expected ${expected[key]}, found ${summary[key]}`);
    }
  }
  return { manifestPath, rows, summary };
}

function encodeGff(value) {
  return encodeURIComponent(String(value)).replaceAll('%20', '+');
}

/**
 * @param {string} text
 * @param {{ studyId: string, accession: string, pmid: string, year: number, sourceFile: string, outputFile: string, recordCount: number }} study
 * @param {Map<string, number> | null} [sequenceLengths]
 */
export function parseExperimentalBed(text, study, sequenceLengths = null) {
  const observations = [];
  const duplicateKeys = new Map();
  const lines = text.split(/\n/);
  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset].replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith('#')) throw new Error(`${study.outputFile}:${offset + 1}: BED comments are not allowed`);
    const fields = line.split('\t');
    if (fields.length !== 6) throw new Error(`${study.outputFile}:${offset + 1}: expected exactly six BED columns`);
    const sequencePrefix = `${study.accession}:`;
    if (!fields[0].startsWith(sequencePrefix) || fields[0].length === sequencePrefix.length) {
      throw new Error(`${study.outputFile}:${offset + 1}: sequence does not use ${study.accession}: prefix`);
    }
    const sequence = fields[0].slice(sequencePrefix.length);
    if (/\s|[\u0000-\u001f\u007f]/.test(sequence)) throw new Error(`${study.outputFile}:${offset + 1}: invalid sequence name`);
    const start0 = Number(fields[1]);
    const end0 = Number(fields[2]);
    if (!Number.isSafeInteger(start0) || !Number.isSafeInteger(end0) || start0 < 0 || end0 !== start0 + 1) {
      throw new Error(`${study.outputFile}:${offset + 1}: experimental TSS must be a 1 bp BED interval`);
    }
    if (!['+', '-'].includes(fields[5])) throw new Error(`${study.outputFile}:${offset + 1}: strand must be + or -`);
    if ([fields[3], fields[4]].some((value) => /[\u0000-\u001f\u007f]/.test(value))) {
      throw new Error(`${study.outputFile}:${offset + 1}: name or description contains control characters`);
    }
    if (sequenceLengths) {
      const length = sequenceLengths.get(sequence);
      if (!length) throw new Error(`${study.outputFile}:${offset + 1}: sequence ${sequence} is absent from reference`);
      if (end0 > length) throw new Error(`${study.outputFile}:${offset + 1}: coordinate exceeds ${sequence} length ${length}`);
    }
    const rawRow = offset + 1;
    const duplicateKey = fields.join('\t');
    const observation = {
      id: `${study.studyId}:${rawRow}`,
      rawRow,
      sequence,
      start: start0 + 1,
      end: start0 + 1,
      name: fields[3],
      description: fields[4],
      strand: fields[5],
      duplicateKey,
    };
    observations.push(observation);
    const group = duplicateKeys.get(duplicateKey) || [];
    group.push(observation);
    duplicateKeys.set(duplicateKey, group);
  }
  if (observations.length !== study.recordCount) {
    throw new Error(`${study.outputFile}: record count mismatch: expected ${study.recordCount}, found ${observations.length}`);
  }
  let duplicateGroupCount = 0;
  let duplicateObservationCount = 0;
  for (const group of duplicateKeys.values()) {
    if (group.length < 2) continue;
    duplicateGroupCount += 1;
    duplicateObservationCount += group.length;
    const groupId = `${study.studyId}:duplicate:${duplicateGroupCount}`;
    for (const observation of group) {
      observation.duplicateGroup = groupId;
      observation.duplicateCount = group.length;
    }
  }
  return { observations, duplicateGroupCount, duplicateObservationCount };
}

export function observationsToGff3(parsed, study) {
  const rows = ['##gff-version 3'];
  const sorted = [...parsed.observations].sort((left, right) => left.sequence.localeCompare(right.sequence)
    || left.start - right.start || left.rawRow - right.rawRow);
  for (const observation of sorted) {
    const attributes = [
      ['ID', observation.id],
      ['Name', observation.name],
      ['description', observation.description],
      ['study_id', study.studyId],
      ['pmid', study.pmid],
      ['year', study.year],
      ['source_file', study.sourceFile],
      ['raw_row', observation.rawRow],
      ['evidence_type', 'experimental'],
    ];
    if (observation.duplicateGroup) {
      attributes.push(['duplicate_group', observation.duplicateGroup], ['duplicate_count', observation.duplicateCount]);
    }
    rows.push([
      observation.sequence,
      'RAPPTOR',
      'experimental_tss',
      observation.start,
      observation.end,
      '.',
      observation.strand,
      '.',
      attributes.map(([key, value]) => `${key}=${encodeGff(value)}`).join(';'),
    ].join('\t'));
  }
  return `${rows.join('\n')}\n`;
}

function emptyPublication(status = 'unavailable') {
  return { title: null, authors: [], journal: null, doi: null, status };
}

function normalizePublication(value, status = 'resolved') {
  if (!value || typeof value !== 'object') return emptyPublication('unavailable');
  return {
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : null,
    authors: Array.isArray(value.authors)
      ? value.authors.map((author) => typeof author === 'string' ? author : author?.name).filter(Boolean)
      : [],
    journal: typeof (value.journal || value.fulljournalname || value.source) === 'string'
      ? (value.journal || value.fulljournalname || value.source) : null,
    doi: typeof value.doi === 'string' ? value.doi : Array.isArray(value.articleids)
      ? value.articleids.find((entry) => entry.idtype === 'doi')?.value || null : null,
    status: value.status === 'unresolved' || value.status === 'unavailable' ? value.status : status,
  };
}

export async function enrichPubmed(pmids, settings = {}) {
  const unique = [...new Set(pmids.map(String))].sort();
  let cache = {};
  if (settings.cachePath && await exists(settings.cachePath)) {
    const parsed = JSON.parse(await readFile(settings.cachePath, 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('PubMed cache must be a JSON object keyed by PMID');
    cache = parsed;
  }
  const fetchImpl = settings.fetchImpl === undefined ? globalThis.fetch : settings.fetchImpl;
  const warnings = [];
  for (const pmid of unique) {
    if (cache[pmid]) {
      cache[pmid] = normalizePublication(cache[pmid], 'resolved');
      continue;
    }
    if (!fetchImpl || settings.offline) {
      cache[pmid] = emptyPublication('unavailable');
      warnings.push(`PMID ${pmid}: metadata unavailable (offline)`);
      continue;
    }
    try {
      const endpoint = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`;
      const response = await fetchImpl(endpoint, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const record = payload?.result?.[pmid];
      if (!record || record.error) {
        cache[pmid] = emptyPublication('unresolved');
        warnings.push(`PMID ${pmid}: metadata was not resolved`);
      } else cache[pmid] = normalizePublication(record);
    } catch (error) {
      cache[pmid] = emptyPublication('unavailable');
      warnings.push(`PMID ${pmid}: metadata fetch failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (settings.cachePath) {
    await mkdir(dirname(settings.cachePath), { recursive: true });
    await writeFile(settings.cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  }
  return { publications: new Map(unique.map((pmid) => [pmid, normalizePublication(cache[pmid])])), warnings };
}

async function readMaybeGzip(path) {
  const buffer = await readFile(path);
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const chunks = [];
    await new Promise((resolvePromise, rejectPromise) => {
      const stream = createReadStream(path).pipe(createGunzip());
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.once('end', resolvePromise);
      stream.once('error', rejectPromise);
    });
    return Buffer.concat(chunks).toString('utf8');
  }
  return buffer.toString('utf8');
}

export async function inspectReferenceFasta(path) {
  const text = await readMaybeGzip(path);
  const sequenceLengths = new Map();
  let current = null;
  let genomeSizeBp = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('>')) {
      current = line.slice(1).trim().split(/\s+/, 1)[0];
      if (!current || sequenceLengths.has(current)) throw new Error(`${path}: invalid or duplicate FASTA sequence`);
      sequenceLengths.set(current, 0);
    } else if (line.trim()) {
      if (!current) throw new Error(`${path}: FASTA sequence precedes header`);
      const sequence = line.trim();
      if (!/^[A-Za-z.*-]+$/.test(sequence)) throw new Error(`${path}: invalid FASTA sequence`);
      sequenceLengths.set(current, sequenceLengths.get(current) + sequence.length);
      genomeSizeBp += sequence.length;
    }
  }
  if (!sequenceLengths.size || !genomeSizeBp) throw new Error(`${path}: empty FASTA`);
  const primarySequence = sequenceLengths.keys().next().value;
  return { sequenceLengths, primarySequence, genomeSizeBp, contigCount: sequenceLengths.size };
}

async function inspectAnnotationGff(path, sequenceLengths) {
  const text = await readMaybeGzip(path);
  let featureCount = 0;
  for (const [offset, line] of text.split(/\r?\n/).entries()) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length !== 9) throw new Error(`${path}:${offset + 1}: annotation row does not have nine columns`);
    const start = Number(fields[3]);
    const end = Number(fields[4]);
    const length = sequenceLengths.get(fields[0]);
    if (!length || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > length) {
      throw new Error(`${path}:${offset + 1}: annotation does not match reference coordinates`);
    }
    featureCount += 1;
  }
  return featureCount;
}

function firstExisting(candidates) {
  return (async () => {
    for (const candidate of candidates) if (await exists(candidate)) return candidate;
    return null;
  })();
}

export async function loadNcbiGenomeAsset(ncbiRoot, accession, settings = {}) {
  if (!ACCESSION.test(accession)) throw new Error(`invalid NCBI accession: ${accession}`);
  const root = join(ncbiRoot, accession);
  if (!(await exists(root))) throw new Error(`${accession}: NCBI asset directory is missing`);
  const metadataPath = join(root, 'metadata.json');
  const metadata = await exists(metadataPath) ? JSON.parse(await readFile(metadataPath, 'utf8')) : {};
  const reference = await firstExisting([
    metadata.reference && resolve(root, metadata.reference),
    join(root, 'reference.fa.gz'), join(root, 'reference.fna.gz'), join(root, 'genomic.fna.gz'), join(root, 'genomic.fna'),
  ].filter(Boolean));
  if (!reference) throw new Error(`${accession}: reference FASTA is missing`);
  const referenceInfo = await inspectReferenceFasta(reference);
  const fai = await firstExisting([metadata.fai && resolve(root, metadata.fai), `${reference}.fai`, join(root, 'reference.fa.gz.fai')].filter(Boolean));
  const gzi = await firstExisting([metadata.gzi && resolve(root, metadata.gzi), `${reference}.gzi`, join(root, 'reference.fa.gz.gzi')].filter(Boolean));
  let annotation = await firstExisting([
    metadata.annotation && resolve(root, metadata.annotation),
    join(root, 'ncbi-annotations.gff3.gz'), join(root, 'genomic.gff.gz'), join(root, 'genomic.gff'),
  ].filter(Boolean));
  let annotationIndex = annotation ? await firstExisting([
    metadata.annotationIndex && resolve(root, metadata.annotationIndex), `${annotation}.tbi`, join(root, 'ncbi-annotations.gff3.gz.tbi'),
  ].filter(Boolean)) : null;
  if (!settings.allowUnindexed && (!fai || !gzi)) throw new Error(`${accession}: indexed BGZF reference (.fai/.gzi) is required`);
  let annotationStatus = annotation ? 'available' : 'missing';
  let annotationFeatureCount = null;
  if (annotation) {
    try {
      annotationFeatureCount = await inspectAnnotationGff(annotation, referenceInfo.sequenceLengths);
    } catch (error) {
      annotationStatus = 'incompatible';
      annotation = null;
      annotationIndex = null;
      if (settings.onWarning) settings.onWarning(`${accession}: NCBI annotation ignored (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (!settings.allowUnindexed && annotation && !annotationIndex) throw new Error(`${accession}: annotation exists without a tabix index`);
  return {
    accession,
    organismName: metadata.organismName || metadata.organism_name || accession,
    strain: metadata.strain || null,
    assemblyName: metadata.assemblyName || metadata.assembly_name || null,
    genbankAssemblyAccession: metadata.genbankAssemblyAccession || metadata.genbank_assembly_accession || null,
    refseqAssemblyAccession: metadata.refseqAssemblyAccession || accession,
    assemblyLevel: metadata.assemblyLevel || metadata.assembly_level || null,
    reference,
    fai,
    gzi,
    annotation,
    annotationIndex,
    annotationStatus,
    annotationFeatureCount,
    ...referenceInfo,
  };
}

export async function fetchNcbiDatasetReports(accessions, settings = {}) {
  const fetchImpl = settings.fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is unavailable');
  const reports = new Map();
  const warnings = [];
  for (const accession of accessions) {
    try {
      const endpoint = `https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/${encodeURIComponent(accession)}/dataset_report`;
      const response = await fetchImpl(endpoint, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      reports.set(accession, await response.json());
    } catch (error) {
      warnings.push(`${accession}: NCBI assembly report unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { reports, warnings };
}

async function walkFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function bgzipFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const outputHandle = await import('node:fs/promises').then(({ open }) => open(destination, 'w'));
  try {
    await runTool('bgzip', ['-c', source], { stdio: ['ignore', outputHandle.fd, 'inherit'] });
  } finally {
    await outputHandle.close();
  }
}

export function datasetReportMetadata(report, accession) {
  const record = report?.reports?.[0] || report || {};
  const assembly = record.assembly_info || record.assemblyInfo || record;
  const organism = record.organism
    || assembly.organism
    || assembly.biosample?.description?.organism
    || {};
  const pairedAssembly = assembly.paired_assembly || assembly.pairedAssembly || {};
  return {
    organismName: organism.organism_name || organism.organismName || organism.name
      || record.organism_name || record.organismName || accession,
    strain: organism.infraspecific_names?.strain || organism.infraspecificNames?.strain
      || organism.strain || assembly.biosample?.strain || null,
    assemblyName: assembly.assembly_name || assembly.assemblyName || assembly.name || null,
    assemblyLevel: assembly.assembly_level || assembly.assemblyLevel || assembly.level || null,
    genbankAssemblyAccession: pairedAssembly.accession?.startsWith('GCA_')
      ? pairedAssembly.accession : record.accession?.startsWith('GCA_') ? record.accession : null,
    refseqAssemblyAccession: accession,
  };
}

export function sortGff3TextForTabix(text) {
  const comments = [];
  const features = [];
  let inFasta = false;
  let featureIndex = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '##FASTA') {
      inFasta = true;
      continue;
    }
    if (inFasta) continue;
    if (!line || line.startsWith('#')) {
      if (line) comments.push(line);
      continue;
    }
    const columns = line.split('\t');
    const start = Number(columns[3]);
    const end = Number(columns[4]);
    if (columns.length !== 9 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error(`invalid NCBI GFF3 feature row: ${line.slice(0, 160)}`);
    }
    features.push({ line, sequence: columns[0], start, end, featureIndex });
    featureIndex += 1;
  }
  features.sort((left, right) => left.sequence.localeCompare(right.sequence)
    || left.start - right.start || left.end - right.end || left.featureIndex - right.featureIndex);
  return `${[...comments, ...features.map((feature) => feature.line)].join('\n')}\n`;
}

async function writeSortedGff3ForTabix(source, destination) {
  await writeFile(destination, sortGff3TextForTabix(await readFile(source, 'utf8')), 'utf8');
}

/**
 * Populate an NCBI asset cache with the official NCBI Datasets CLI. The caller
 * chooses the cache root, so large archives never need to enter the Git tree.
 */
export async function acquireNcbiGenomeAssets(accessions, ncbiRoot, settings = {}) {
  const datasetsCommand = settings.datasetsCommand || 'datasets';
  await mkdir(ncbiRoot, { recursive: true });
  const downloaded = [];
  const reused = [];
  for (const accession of [...new Set(accessions)].sort()) {
    const target = join(ncbiRoot, accession);
    if (await exists(join(target, 'reference.fa.gz'))) {
      reused.push(accession);
      continue;
    }
    const work = join(ncbiRoot, `.acquire-${accession}-${process.pid}`);
    const archive = join(work, `${accession}.zip`);
    const extracted = join(work, 'extracted');
    await mkdir(extracted, { recursive: true });
    try {
      await runTool(datasetsCommand, [
        'download', 'genome', 'accession', accession,
        '--include', 'genome,gff3,seq-report', '--filename', archive,
      ]);
      await runTool('tar', ['-xf', archive, '-C', extracted]);
      const files = await walkFiles(extracted);
      const fasta = files.find((path) => /(?:genomic|genome)\.fna$/i.test(path));
      if (!fasta) throw new Error(`${accession}: NCBI archive does not contain genomic FASTA`);
      const gff = files.find((path) => /(?:genomic|genome)\.gff3?$/i.test(path));
      await mkdir(target, { recursive: true });
      await bgzipFile(fasta, join(target, 'reference.fa.gz'));
      await runTool('samtools', ['faidx', join(target, 'reference.fa.gz')]);
      if (!(await exists(join(target, 'reference.fa.gz.gzi')))) {
        throw new Error(`${accession}: samtools did not create the BGZF .gzi index`);
      }
      if (gff) {
        const sortedGff = join(work, `${accession}.ncbi-annotations.sorted.gff3`);
        await writeSortedGff3ForTabix(gff, sortedGff);
        await bgzipFile(sortedGff, join(target, 'ncbi-annotations.gff3.gz'));
        try {
          await runTool('tabix', ['-f', '-p', 'gff', join(target, 'ncbi-annotations.gff3.gz')]);
        } catch (error) {
          await rm(join(target, 'ncbi-annotations.gff3.gz'), { force: true });
          await rm(join(target, 'ncbi-annotations.gff3.gz.tbi'), { force: true });
          if (settings.onWarning) settings.onWarning(`${accession}: NCBI annotation could not be indexed and was omitted (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      const reportFile = files.find((path) => /assembly_data_report\.jsonl$/i.test(path));
      let report = null;
      if (reportFile) {
        const first = (await readFile(reportFile, 'utf8')).split(/\r?\n/).find(Boolean);
        if (first) report = JSON.parse(first);
      }
      if (!report && settings.fetchImpl !== null) {
        const fetched = await fetchNcbiDatasetReports([accession], settings);
        report = fetched.reports.get(accession) || null;
      }
      await writeFile(join(target, 'metadata.json'), `${JSON.stringify(datasetReportMetadata(report, accession), null, 2)}\n`, 'utf8');
      downloaded.push(accession);
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  return { downloaded, reused };
}

export async function validateExperimentalSource(sourceRoot, settings = {}) {
  const manifest = await parseExperimentalManifest(sourceRoot, { expected: settings.expected });
  if (!settings.originalSourceRoot && !settings.trustSourceChecksums) {
    throw new Error('original source BED directory is required to verify source_sha256 (or explicitly trust recorded source checksums)');
  }
  let observations = 0;
  let duplicateGroups = 0;
  let duplicateObservations = 0;
  for (const row of manifest.rows) {
    const normalized = join(sourceRoot, row.outputFile);
    if (!(await exists(normalized))) throw new Error(`${row.studyId}: normalized BED is missing`);
    if (settings.originalSourceRoot) {
      const original = join(resolve(settings.originalSourceRoot), row.sourceFile);
      if (!(await exists(original))) throw new Error(`${row.studyId}: original BED is missing`);
      if (await hashFile(original) !== row.sourceSha256) throw new Error(`${row.studyId}: original BED SHA-256 mismatch`);
    }
    const parsed = parseExperimentalBed(await readFile(normalized, 'utf8'), row);
    observations += parsed.observations.length;
    duplicateGroups += parsed.duplicateGroupCount;
    duplicateObservations += parsed.duplicateObservationCount;
  }
  if (observations !== manifest.summary.observations) throw new Error('source observation sum mismatch');
  return { ...manifest.summary, validatedObservations: observations, duplicateGroups, duplicateObservations };
}

function sqlText(value) {
  return value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  return value === null || value === undefined ? 'NULL' : String(Number(value));
}

function searchTokens(...values) {
  const tokens = new Set();
  for (const raw of values.filter((value) => value !== null && value !== undefined)) {
    const normalized = String(raw).toLocaleLowerCase().normalize('NFKC').trim();
    if (normalized) tokens.add(normalized);
    for (const token of normalized.split(/[^\p{L}\p{N}_.-]+/u).filter(Boolean)) tokens.add(token);
  }
  return [...tokens].sort();
}

export function buildExperimentalD1Sql(catalog, settings = {}) {
  const releaseId = catalog.releaseId;
  const hfRepository = settings.hfRepository || null;
  const hfRevision = settings.hfRevision || 'main';
  const definitionRows = catalog.studies.map((study) => `(${[
    sqlText(releaseId), sqlText(study.studyId), sqlText('experimental_tss'), sqlText('experimental'), sqlText('observation'),
    sqlText(study.studyId), sqlText(`pmid:${study.pmid}`),
    sqlText(JSON.stringify({ pmid: study.pmid, year: study.year, publication: study.publication })), sqlText(catalog.generatedAt),
  ].join(', ')})`);
  const annotationDefinitionId = `gene-annotation:ncbi:${releaseId}`;
  definitionRows.push(`(${[
    sqlText(releaseId), sqlText(annotationDefinitionId), sqlText('gene_annotation'), sqlText('annotation'), sqlText('feature'),
    sqlText('NCBI'), sqlText('per-assembly'), sqlText(JSON.stringify({ provider: 'NCBI Datasets' })), sqlText(catalog.generatedAt),
  ].join(', ')})`);
  const genomeRows = catalog.genomes.map((genome) => `(${[
    sqlText(releaseId), sqlText(genome.accession), sqlText(genome.organismName), sqlText(genome.strain), 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL',
    sqlText('NCBI RefSeq'), sqlText(genome.assemblyLevel), sqlNumber(genome.genomeSizeBp), 'NULL', sqlNumber(genome.contigCount), 'NULL', 'NULL',
    sqlText(genome.defaultLocus), sqlText(genome.primarySequence), sqlText(JSON.stringify(genome.referenceStorage)),
    sqlText(genome.organismName), 'NULL', sqlText(genome.assemblyName), sqlText(genome.genbankAssemblyAccession), sqlText(genome.accession),
    'NULL', 'NULL', sqlText('NCBI'), 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL',
  ].join(', ')})`);
  const studiesByAccession = new Map();
  for (const study of catalog.studies) {
    const group = studiesByAccession.get(study.accession) || [];
    group.push(study);
    studiesByAccession.set(study.accession, group);
  }
  const featureRows = [];
  for (const [accession, studies] of studiesByAccession) {
    studies.forEach((study, index) => featureRows.push(`(${[
      sqlText(releaseId), sqlText(accession), sqlText(study.studyId), sqlText('experimental_tss'), sqlText('experimental'),
      sqlText('observation'), sqlNumber(study.recordCount), sqlText('ready'), index === 0 ? '1' : '0', sqlText(study.studyId),
      sqlText(`pmid:${study.pmid}`), sqlText(JSON.stringify({
        pmid: study.pmid,
        year: study.year,
        rawBedPath: study.assets.rawBed,
        sourceFile: study.sourceFile,
        sourceSha256: study.sourceSha256,
        datasetRow: study.datasetRow,
        duplicateGroupCount: study.duplicateGroupCount,
        duplicateObservationCount: study.duplicateObservationCount || 0,
      })), sqlText(JSON.stringify({ observations: study.recordCount, duplicateGroups: study.duplicateGroupCount || 0 })),
      sqlText(study.assets.data), sqlText(study.assets.index), sqlText(study.checksums.data), sqlText(study.checksums.index),
      sqlText(JSON.stringify({ layout: 'individual-v1', files: study.assets })),
    ].join(', ')})`));
  }
  for (const genome of catalog.genomes) {
    const available = genome.annotation.status === 'available';
    featureRows.push(`(${[
      sqlText(releaseId), sqlText(genome.accession), sqlText(annotationDefinitionId), sqlText('gene_annotation'), sqlText('annotation'),
      sqlText('feature'), available && Number.isSafeInteger(genome.annotation.featureCount) ? sqlNumber(genome.annotation.featureCount) : 'NULL',
      sqlText(available ? 'ready' : genome.annotation.status === 'incompatible' ? 'failed' : 'missing'), '1', sqlText('NCBI'), sqlText('per-assembly'),
      sqlText(JSON.stringify({ provider: 'NCBI Datasets', assemblyAccession: genome.accession })), sqlText('{}'),
      sqlText(genome.annotation.data), sqlText(genome.annotation.index), sqlText(genome.checksums?.ncbiAnnotations),
      sqlText(genome.checksums?.ncbiAnnotationsIndex), sqlText(JSON.stringify({
        layout: 'individual-v1', files: { data: genome.annotation.data, index: genome.annotation.index },
      })),
    ].join(', ')})`);
  }
  const tokenRows = [];
  for (const genome of catalog.genomes) {
    const studies = studiesByAccession.get(genome.accession) || [];
    for (const token of searchTokens(genome.accession, genome.organismName, genome.strain,
      ...studies.flatMap((study) => [study.studyId, study.pmid, study.year, study.publication.title, study.publication.journal]))) {
      tokenRows.push(`(${sqlText(releaseId)}, ${sqlText(genome.accession)}, ${sqlText(token)})`);
    }
  }
  const featureSummary = {
    experimentalTss: catalog.summary.observations,
    experimentalStudies: catalog.summary.studies,
    publications: catalog.summary.publications,
    annotationAvailable: catalog.genomes.filter((genome) => genome.annotation.status === 'available').length,
  };
  const init = [
    'PRAGMA foreign_keys = ON;',
    `DELETE FROM releases WHERE release_id = ${sqlText(releaseId)} AND publication_status = 'staged';`,
    `INSERT INTO releases (release_id, source_release_id, release_date, generated_at, description, storage_layout, hf_repository, hf_revision, release_asset_base_url, manifest_index_path, total_genomes, feature_summary_json, dataset_version, metadata_schema_version, publication_status, release_kind) VALUES (${[
      sqlText(releaseId), sqlText('experimental-tss-by-study'), sqlText(catalog.releaseDate), sqlText(catalog.generatedAt),
      sqlText(catalog.description), sqlText('individual-v1'), sqlText(hfRepository), sqlText(hfRevision), sqlText(catalog.assetBase || null),
      sqlText('manifest.tsv'), sqlNumber(catalog.summary.genomes), sqlText(JSON.stringify(featureSummary)), sqlText(releaseId),
      sqlText(String(catalog.schemaVersion)), sqlText('staged'), sqlText('experimental_tss'),
    ].join(', ')});`,
    `INSERT INTO feature_definitions (release_id, definition_id, feature_type, evidence_type, count_unit, source_id, source_version, configuration_json, generated_at) VALUES\n${definitionRows.join(',\n')};`,
  ].join('\n');
  const genomes = `PRAGMA foreign_keys = ON;\nINSERT INTO genomes (release_id, accession, organism_name, strain, domain, phylum, class_name, order_name, family, genus, genome_source, assembly_level, genome_size_bp, gc_content, contig_count, completeness, contamination, default_locus, primary_sequence, reference_storage_json, ncbi_organism_name, ncbi_tax_id, assembly_name, genbank_assembly_accession, refseq_assembly_accession, taxonomy_raw, species, taxonomy_source, gtdb_representative, gtdb_genome_representative, contig_n50, longest_contig_bp, ambiguous_bases, coding_density, protein_count, trna_count, ssu_rrna_count, lsu_23s_rrna_count, strain_heterogeneity, mimag_quality, assembly_source_url) VALUES\n${genomeRows.join(',\n')};\n`;
  const features = `PRAGMA foreign_keys = ON;\nINSERT INTO feature_sets (release_id, accession, definition_id, feature_type, evidence_type, count_unit, feature_count, status, is_default, source_id, source_version, provenance_json, detail_counts_json, data_path, index_path, data_sha256, index_sha256, storage_json) VALUES\n${featureRows.join(',\n')};\n`;
  const tokens = tokenRows.length
    ? `PRAGMA foreign_keys = ON;\nINSERT INTO genome_search_terms (release_id, accession, token) VALUES\n${tokenRows.join(',\n')};\n`
    : 'PRAGMA foreign_keys = ON;\n';
  const activate = `PRAGMA foreign_keys = ON;\nUPDATE releases SET publication_status = 'ready' WHERE release_id = ${sqlText(releaseId)} AND release_kind = 'experimental_tss';\nINSERT INTO experimental_portal_state (singleton, active_release_id) SELECT 1, release_id FROM releases WHERE release_id = ${sqlText(releaseId)} AND release_kind = 'experimental_tss' AND publication_status = 'ready' ON CONFLICT(singleton) DO UPDATE SET active_release_id = excluded.active_release_id;\n`;
  return { init, genomes, features, tokens, activate };
}

async function copyRequired(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  return hashFile(target);
}

async function copyReference(source, target) {
  const header = (await readFile(source)).subarray(0, 2);
  await mkdir(dirname(target), { recursive: true });
  if (header[0] === 0x1f && header[1] === 0x8b) await copyFile(source, target);
  else await writeFile(target, await gzip(await readFile(source), { level: 9, mtime: 0 }));
  return hashFile(target);
}

async function runTool(command, args, settings = {}) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true, stdio: settings.stdio || 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`${command} exited with ${code ?? signal}`)));
  });
}

async function writeIndexedGff(text, destination) {
  const plain = destination.replace(/\.gz$/, '');
  await writeFile(plain, text, 'utf8');
  const outputHandle = await import('node:fs/promises').then(({ open }) => open(destination, 'w'));
  try {
    await runTool('bgzip', ['-c', plain], { stdio: ['ignore', outputHandle.fd, 'inherit'] });
  } finally {
    await outputHandle.close();
    await import('node:fs/promises').then(({ rm }) => rm(plain, { force: true }));
  }
  await runTool('tabix', ['-f', '-p', 'gff', destination]);
}

export async function buildExperimentalRelease(settings) {
  const sourceRoot = resolve(settings.sourceRoot);
  const ncbiRoot = resolve(settings.ncbiRoot);
  const output = resolve(settings.output);
  if (await exists(output) && !settings.force) throw new Error(`output exists: ${output} (use --force to replace it)`);
  const productionBaseline = settings.expected === undefined || settings.expected === EXPERIMENTAL_TSS_BASELINE;
  let assetBase = null;
  if (settings.assetBase !== null && settings.assetBase !== undefined && settings.assetBase !== '') {
    let parsedAssetBase;
    try {
      parsedAssetBase = new URL(settings.assetBase);
    } catch {
      throw new Error('assetBase must be a valid HTTPS URL');
    }
    if (parsedAssetBase.protocol !== 'https:' || parsedAssetBase.username || parsedAssetBase.password
      || parsedAssetBase.search || parsedAssetBase.hash) {
      throw new Error('assetBase must be a valid HTTPS URL without credentials, query, or fragment');
    }
    assetBase = parsedAssetBase.toString().replace(/\/$/, '');
  }
  if (productionBaseline && !assetBase) {
    throw new Error('production build requires an HTTPS assetBase (CLI: --asset-base)');
  }
  const manifest = await parseExperimentalManifest(sourceRoot, { expected: settings.expected === undefined ? EXPERIMENTAL_TSS_BASELINE : settings.expected });
  if (productionBaseline && !settings.originalSourceRoot && !settings.trustSourceChecksums) {
    throw new Error('production build requires originalSourceRoot to verify source_sha256; use trustSourceChecksums only after an external provenance audit');
  }
  const pubmed = await enrichPubmed(manifest.rows.map((row) => row.pmid), {
    cachePath: settings.pubmedCache,
    fetchImpl: settings.fetchImpl,
    offline: settings.offline,
  });
  const stage = `${output}.building-${process.pid}`;
  if (await exists(stage)) throw new Error(`build stage already exists: ${stage}`);
  await mkdir(stage, { recursive: true });
  const genomesByAccession = new Map();
  const studies = [];
  const knownHashes = new Map();
  const buildWarnings = [...pubmed.warnings];
  if (!settings.originalSourceRoot) {
    buildWarnings.push('Original source BED directory was not supplied; source_sha256 values are retained as provenance but cannot be reverified.');
  }
  try {
    for (const accession of [...new Set(manifest.rows.map((row) => row.accession))].sort()) {
      const input = await loadNcbiGenomeAsset(ncbiRoot, accession, { allowUnindexed: settings.allowUnindexed });
      const objectPrefix = `objects/${accession}`;
      const fastaPath = `${objectPrefix}/reference.fa.gz`;
      const fastaFaiPath = input.fai ? `${objectPrefix}/reference.fa.gz.fai` : null;
      const fastaGziPath = input.gzi ? `${objectPrefix}/reference.fa.gz.gzi` : null;
      knownHashes.set(fastaPath, await copyReference(input.reference, join(stage, fastaPath)));
      if (input.fai) knownHashes.set(fastaFaiPath, await copyRequired(input.fai, join(stage, fastaFaiPath)));
      if (input.gzi) knownHashes.set(fastaGziPath, await copyRequired(input.gzi, join(stage, fastaGziPath)));
      let annotationData = null;
      let annotationIndex = null;
      if (input.annotation) {
        annotationData = `${objectPrefix}/ncbi-annotations.gff3.gz`;
        knownHashes.set(annotationData, await copyRequired(input.annotation, join(stage, annotationData)));
        if (input.annotationIndex) {
          annotationIndex = `${annotationData}.tbi`;
          knownHashes.set(annotationIndex, await copyRequired(input.annotationIndex, join(stage, annotationIndex)));
        }
      }
      const referenceStorage = {
        layout: 'individual-v1',
        files: { fasta: fastaPath, fai: fastaFaiPath, gzi: fastaGziPath },
        checksums: {
          fasta: knownHashes.get(fastaPath),
          fai: fastaFaiPath ? knownHashes.get(fastaFaiPath) : null,
          gzi: fastaGziPath ? knownHashes.get(fastaGziPath) : null,
        },
      };
      genomesByAccession.set(accession, {
        releaseId: settings.releaseId,
        accession,
        organismName: input.organismName,
        strain: input.strain,
        assemblyName: input.assemblyName,
        assemblyLevel: input.assemblyLevel,
        genbankAssemblyAccession: input.genbankAssemblyAccession,
        primarySequence: input.primarySequence,
        defaultLocus: `${input.primarySequence}:1-${Math.min(10_000, input.sequenceLengths.get(input.primarySequence))}`,
        genomeSizeBp: input.genomeSizeBp,
        contigCount: input.contigCount,
        annotationStatus: input.annotationStatus,
        assets: {
          fasta: fastaPath,
          fastaFai: fastaFaiPath,
          fastaGzi: fastaGziPath,
          ncbiAnnotations: annotationData,
          ncbiAnnotationsIndex: annotationIndex,
        },
        referenceStorage,
        annotation: { status: input.annotationStatus, data: annotationData, index: annotationIndex, featureCount: input.annotationFeatureCount },
        checksums: {
          fasta: knownHashes.get(fastaPath),
          fastaFai: fastaFaiPath ? knownHashes.get(fastaFaiPath) : null,
          fastaGzi: fastaGziPath ? knownHashes.get(fastaGziPath) : null,
          ncbiAnnotations: annotationData ? knownHashes.get(annotationData) : null,
          ncbiAnnotationsIndex: annotationIndex ? knownHashes.get(annotationIndex) : null,
        },
        studies: [],
        _sequenceLengths: input.sequenceLengths,
      });
    }
    for (const row of manifest.rows) {
      const sourceBed = join(sourceRoot, row.outputFile);
      if (!(await exists(sourceBed))) throw new Error(`${row.studyId}: BED file is missing: ${row.outputFile}`);
      if (settings.originalSourceRoot) {
        const originalSource = join(resolve(settings.originalSourceRoot), row.sourceFile);
        if (!(await exists(originalSource))) throw new Error(`${row.studyId}: original source BED is missing: ${row.sourceFile}`);
        const sourceHash = await hashFile(originalSource);
        if (sourceHash !== row.sourceSha256) throw new Error(`${row.studyId}: original source BED SHA-256 mismatch`);
      }
      const genome = genomesByAccession.get(row.accession);
      const parsed = parseExperimentalBed(await readFile(sourceBed, 'utf8'), row, genome._sequenceLengths);
      if (!genome._firstObservation) genome._firstObservation = parsed.observations[0];
      const prefix = `objects/${row.accession}/studies/${row.studyId}`;
      const rawBed = `${prefix}/raw.bed`;
      const data = `${prefix}/experimental-tss.gff3.gz`;
      const index = settings.allowUnindexed ? null : `${data}.tbi`;
      knownHashes.set(rawBed, await copyRequired(sourceBed, join(stage, rawBed)));
      await mkdir(dirname(join(stage, data)), { recursive: true });
      const gffText = observationsToGff3(parsed, row);
      if (settings.allowUnindexed) {
        await writeFile(join(stage, data), await gzip(Buffer.from(gffText), { level: 9, mtime: 0 }));
      } else {
        await writeIndexedGff(gffText, join(stage, data));
      }
      knownHashes.set(data, await hashFile(join(stage, data)));
      if (index) {
        if (!(await exists(join(stage, index)))) throw new Error(`${row.studyId}: tabix did not create an index`);
        knownHashes.set(index, await hashFile(join(stage, index)));
      }
      const study = {
        studyId: row.studyId,
        datasetRow: row.datasetRow,
        accession: row.accession,
        organismName: genome.organismName,
        pmid: row.pmid,
        year: row.year,
        recordCount: row.recordCount,
        sourceFile: row.sourceFile,
        sourceSha256: row.sourceSha256,
        duplicateGroupCount: parsed.duplicateGroupCount,
        duplicateObservationCount: parsed.duplicateObservationCount,
        publication: pubmed.publications.get(row.pmid) || emptyPublication(),
        assets: { rawBed, data, index },
        checksums: {
          rawBed: knownHashes.get(rawBed),
          data: knownHashes.get(data),
          index: index ? knownHashes.get(index) : null,
        },
      };
      studies.push(study);
      genome.studies.push(row.studyId);
    }
    const genomes = [...genomesByAccession.values()].map((genome) => {
      const { _sequenceLengths, _firstObservation, ...publicGenome } = genome;
      void _sequenceLengths;
      if (_firstObservation) {
        const length = _sequenceLengths.get(_firstObservation.sequence);
        const start = Math.max(1, _firstObservation.start - 500);
        const end = Math.min(length, start + 999);
        publicGenome.defaultLocus = `${_firstObservation.sequence}:${start}-${end}`;
      }
      return publicGenome;
    });
    const generatedAt = settings.generatedAt || new Date().toISOString();
    const catalog = {
      schemaVersion: 1,
      releaseId: settings.releaseId,
      releaseKind: 'experimental_tss',
      releaseDate: settings.releaseDate,
      generatedAt,
      description: settings.description || 'Experimentally mapped bacterial transcription start sites grouped by study.',
      assetBase,
      summary: { ...manifest.summary, years: [...new Set(studies.map((study) => study.year))].sort() },
      warnings: buildWarnings,
      studies,
      genomes,
    };
    await writeFile(join(stage, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    knownHashes.set('catalog.json', await hashFile(join(stage, 'catalog.json')));
    await writeFile(join(stage, 'studies.json'), `${JSON.stringify(studies, null, 2)}\n`, 'utf8');
    knownHashes.set('studies.json', await hashFile(join(stage, 'studies.json')));
    await writeFile(join(stage, 'pubmed-metadata.json'), `${JSON.stringify(Object.fromEntries(pubmed.publications), null, 2)}\n`, 'utf8');
    knownHashes.set('pubmed-metadata.json', await hashFile(join(stage, 'pubmed-metadata.json')));
    const sql = buildExperimentalD1Sql(catalog, settings);
    await mkdir(join(stage, 'd1'), { recursive: true });
    for (const [file, text] of Object.entries({
      '00-init.sql': sql.init,
      '10-genomes.sql': sql.genomes,
      '20-feature-sets.sql': sql.features,
      '30-search-terms.sql': sql.tokens,
      '90-activate.sql': sql.activate,
    })) {
      const path = `d1/${file}`;
      await writeFile(join(stage, path), text, 'utf8');
      knownHashes.set(path, await hashFile(join(stage, path)));
    }
    const manifestRows = ['path\tbytes\tsha256'];
    for (const [path, digest] of [...knownHashes].sort(([left], [right]) => left.localeCompare(right))) {
      manifestRows.push(`${path}\t${(await stat(join(stage, path))).size}\t${digest}`);
    }
    await writeFile(join(stage, 'manifest.tsv'), `${manifestRows.join('\n')}\n`, 'utf8');
    knownHashes.set('manifest.tsv', await hashFile(join(stage, 'manifest.tsv')));
    const checksums = [...knownHashes].sort(([left], [right]) => left.localeCompare(right))
      .map(([path, digest]) => `${digest}  ${path}`).join('\n');
    await writeFile(join(stage, 'checksums.sha256'), `${checksums}\n`, 'utf8');
    await mkdir(dirname(output), { recursive: true });
    const { rename, rm } = await import('node:fs/promises');
    if (await exists(output)) await rm(output, { recursive: true, force: true });
    await rename(stage, output);
    return { catalog, output, warnings: buildWarnings };
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function validateExperimentalRelease(root, settings = {}) {
  const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
  if (catalog.schemaVersion !== 1 || catalog.releaseKind !== 'experimental_tss') throw new Error('unsupported experimental catalog');
  const expected = settings.expected === false ? null : settings.expected || EXPERIMENTAL_TSS_BASELINE;
  if (expected) for (const key of Object.keys(EXPERIMENTAL_TSS_BASELINE)) {
    if (catalog.summary[key] !== expected[key]) throw new Error(`catalog ${key} mismatch`);
  }
  if (!Array.isArray(catalog.studies) || !Array.isArray(catalog.genomes)) throw new Error('catalog studies/genomes are invalid');
  const checksumLines = (await readFile(join(root, 'checksums.sha256'), 'utf8')).trim().split(/\r?\n/);
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`invalid checksum row: ${line}`);
    safeReleasePath(match[2], 'checksum path');
    if (checksums.has(match[2])) throw new Error(`duplicate checksum path: ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  for (const required of ['catalog.json', 'studies.json', 'pubmed-metadata.json', 'manifest.tsv',
    'd1/00-init.sql', 'd1/10-genomes.sql', 'd1/20-feature-sets.sql', 'd1/30-search-terms.sql', 'd1/90-activate.sql']) {
    if (!checksums.has(required)) throw new Error(`required release file is absent from checksums: ${required}`);
  }
  for (const [path, expectedHash] of checksums) {
    const target = resolve(root, path);
    const relativeTarget = relative(resolve(root), target);
    if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget) || !(await exists(target))) throw new Error(`missing or unsafe release asset: ${path}`);
    if (await hashFile(target) !== expectedHash) throw new Error(`checksum mismatch: ${path}`);
  }
  const manifestLines = (await readFile(join(root, 'manifest.tsv'), 'utf8')).trim().split(/\r?\n/);
  if (manifestLines.shift() !== 'path\tbytes\tsha256') throw new Error('invalid release manifest header');
  const manifestPaths = new Set();
  for (const line of manifestLines) {
    const [path, bytesText, digest, ...extra] = line.split('\t');
    if (extra.length || !checksums.has(path) || checksums.get(path) !== digest || path === 'manifest.tsv') {
      throw new Error(`release manifest does not match checksums: ${line}`);
    }
    if (manifestPaths.has(path)) throw new Error(`duplicate release manifest path: ${path}`);
    const bytes = Number(bytesText);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || (await stat(join(root, path))).size !== bytes) {
      throw new Error(`release manifest byte count mismatch: ${path}`);
    }
    manifestPaths.add(path);
  }
  const checksumWithoutManifest = new Set([...checksums.keys()].filter((path) => path !== 'manifest.tsv'));
  if (manifestPaths.size !== checksumWithoutManifest.size || [...manifestPaths].some((path) => !checksumWithoutManifest.has(path))) {
    throw new Error('release manifest path inventory is incomplete');
  }
  const diskFiles = (await walkFiles(root)).map((path) => relative(root, path).replaceAll('\\', '/')).sort();
  const expectedDiskFiles = [...checksums.keys(), 'checksums.sha256'].sort();
  if (diskFiles.length !== expectedDiskFiles.length || diskFiles.some((path, index) => path !== expectedDiskFiles[index])) {
    throw new Error('release contains unregistered or missing files');
  }
  const studyIds = new Set();
  let observations = 0;
  for (const study of catalog.studies) {
    if (studyIds.has(study.studyId)) throw new Error(`duplicate catalog study: ${study.studyId}`);
    studyIds.add(study.studyId);
    observations += study.recordCount;
    for (const path of [study.assets.rawBed, study.assets.data, study.assets.index].filter(Boolean)) {
      safeReleasePath(path);
      if (!checksums.has(path)) throw new Error(`${study.studyId}: asset is absent from checksums: ${path}`);
    }
    for (const [key, path] of Object.entries(study.assets)) {
      if (!path) continue;
      const expectedHash = study.checksums?.[key];
      if (expectedHash !== checksums.get(path)) throw new Error(`${study.studyId}: catalog checksum mismatch for ${key}`);
    }
    const gff = await readMaybeGzip(join(root, study.assets.data));
    const features = gff.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
    if (features.length !== study.recordCount) throw new Error(`${study.studyId}: GFF3 record count mismatch`);
    for (const line of features) {
      const fields = line.split('\t');
      if (fields.length !== 9 || fields[2] !== 'experimental_tss' || fields[3] !== fields[4] || !['+', '-'].includes(fields[6])) {
        throw new Error(`${study.studyId}: invalid experimental GFF3 row`);
      }
    }
  }
  if (observations !== catalog.summary.observations) throw new Error('catalog observation sum mismatch');
  for (const genome of catalog.genomes) {
    if (!ACCESSION.test(genome.accession)) throw new Error(`invalid catalog genome: ${genome.accession}`);
    for (const path of Object.values(genome.referenceStorage?.files || {}).filter(Boolean)) {
      safeReleasePath(path);
      if (!checksums.has(path)) throw new Error(`${genome.accession}: reference asset missing from checksums`);
    }
    for (const [key, path] of Object.entries(genome.assets || {})) {
      if (!path) continue;
      safeReleasePath(path);
      if (!checksums.has(path)) throw new Error(`${genome.accession}: catalog asset missing from checksums: ${key}`);
    }
    if (!['available', 'missing', 'incompatible'].includes(genome.annotation?.status)) throw new Error(`${genome.accession}: invalid annotation status`);
  }
  return { releaseId: catalog.releaseId, summary: catalog.summary, files: checksums.size };
}
