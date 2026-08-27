import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HEADER = [
  'study_id', 'dataset_row', 'gcf', 'pmid', 'year', 'source_file', 'source_sha256', 'output_file',
  'record_count', 'title', 'authors', 'journal', 'doi', 'publication_status', 'organism_name',
  'strain', 'assembly_name', 'assembly_level', 'current_accession', 'assembly_status',
  'genbank_assembly_accession', 'tax_id', 'genome_size_bp', 'contig_count', 'gc_percent', 'ncbi_status',
];
const SHA256 = /^[0-9a-f]{64}$/;
const GCF = /^GCF_\d{9}\.\d+$/;
const GCA = /^GCA_\d{9}\.\d+$/;

function sqlText(value) {
  return value === null || value === undefined || value === ''
    ? 'NULL'
    : `'${String(value).replaceAll("'", "''")}'`;
}

function chunks(values, size = 25) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

function insertSql(table, columns, rows, conflict) {
  return chunks(rows).map((group) => [
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES`,
    `${group.join(',\n')}\n${conflict};`,
  ].join('\n')).join('\n\n');
}

function uniqueBy(rows, key, signature) {
  const values = new Map();
  for (const row of rows) {
    const id = row[key];
    const existing = values.get(id);
    const current = signature(row);
    if (existing && existing.signature !== current) throw new Error(`${key} ${id} has conflicting metadata`);
    values.set(id, { row, signature: current });
  }
  return [...values.values()].map(({ row }) => row);
}

export function parseExperimentalTssMetadata(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  const header = lines.shift()?.split('\t') || [];
  if (header.length !== HEADER.length || header.some((name, index) => name !== HEADER[index])) {
    throw new Error(`unexpected header; expected ${HEADER.join('\t')}`);
  }
  const rows = lines.map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== HEADER.length) throw new Error(`row ${index + 2} does not have ${HEADER.length} fields`);
    const row = Object.fromEntries(HEADER.map((name, fieldIndex) => [name, fields[fieldIndex].trim()]));
    const numbers = ['dataset_row', 'year', 'record_count', 'tax_id', 'genome_size_bp', 'contig_count', 'gc_percent'];
    if (!GCF.test(row.gcf) || !GCF.test(row.current_accession) || !GCA.test(row.genbank_assembly_accession)) {
      throw new Error(`row ${index + 2} has an invalid assembly accession`);
    }
    if (!row.study_id.endsWith(`_${row.gcf}`) || !row.study_id.startsWith(`${row.year}_`) || !SHA256.test(row.source_sha256)) {
      throw new Error(`row ${index + 2} has an invalid study identity`);
    }
    if (numbers.some((name) => !Number.isFinite(Number(row[name]))) || Number(row.record_count) < 1
      || Number(row.gc_percent) < 0 || Number(row.gc_percent) > 100) {
      throw new Error(`row ${index + 2} has invalid numeric metadata`);
    }
    return row;
  });
  if (new Set(rows.map((row) => row.study_id)).size !== rows.length) throw new Error('study_id values must be unique');
  if (new Set(rows.map((row) => row.dataset_row)).size !== rows.length) throw new Error('dataset_row values must be unique');
  const publications = uniqueBy(rows, 'pmid', (row) => [row.year, row.title, row.authors, row.journal, row.doi].join('\t'));
  const genomes = uniqueBy(rows, 'gcf', (row) => [
    row.organism_name, row.strain, row.assembly_name, row.assembly_level, row.current_accession,
    row.assembly_status, row.genbank_assembly_accession, row.tax_id, row.genome_size_bp,
    row.contig_count, row.gc_percent, row.ncbi_status,
  ].join('\t'));
  return { rows, publications, genomes };
}

export function buildExperimentalTssMetadataSql(parsed) {
  const genomeId = (row) => `ncbi_assembly:${row.genbank_assembly_accession}`;
  const publications = parsed.publications.map((row) => `(${[
    sqlText(`pmid:${row.pmid}`), sqlText(row.pmid), sqlText(row.doi), sqlText(row.title),
    sqlText(JSON.stringify(row.authors.split(/\s*;\s*/).filter(Boolean))), sqlText(row.journal), row.year,
    sqlText(JSON.stringify({ status: row.publication_status, importedFrom: 'experimental-tss-metadata.tsv' })),
  ].join(', ')})`);
  const genomes = parsed.genomes.map((row) => `(${[
    sqlText(genomeId(row)), sqlText(row.genbank_assembly_accession), sqlText('ncbi_assembly'),
    sqlText(row.current_accession), sqlText(row.organism_name), sqlText('NCBI'), sqlText(JSON.stringify({
      sourceAccession: row.gcf,
      currentAccession: row.current_accession,
      genbankAssemblyAccession: row.genbank_assembly_accession,
      strain: row.strain || null,
      assemblyName: row.assembly_name,
      assemblyLevel: row.assembly_level,
      assemblyStatus: row.assembly_status,
      taxId: Number(row.tax_id),
      genomeSizeBp: Number(row.genome_size_bp),
      contigCount: Number(row.contig_count),
      gcPercent: Number(row.gc_percent),
      ncbiStatus: row.ncbi_status,
      importedFrom: 'experimental-tss-metadata.tsv',
    })),
  ].join(', ')})`);
  const aliases = parsed.genomes.flatMap((row) => {
    const values = [
      ['ncbi_genbank', row.genbank_assembly_accession, 'canonical'],
      ['ncbi_refseq', row.gcf, 'experimental_source'],
      ['rapptor_accession', row.gcf, 'experimental_source'],
    ];
    if (row.current_accession !== row.gcf) values.push(['ncbi_refseq_current', row.current_accession, 'current_accession']);
    return values.map(([namespace, alias, relation]) => `(${[
      sqlText(genomeId(row)), sqlText(namespace), sqlText(alias), sqlText(relation),
    ].join(', ')})`);
  });
  const studies = parsed.rows.map((row) => `(${[
    sqlText(row.study_id), sqlText(`pmid:${row.pmid}`), sqlText(row.source_file), sqlText(row.source_sha256),
    row.year, sqlText(JSON.stringify({
      datasetRow: Number(row.dataset_row),
      sourceAccession: row.gcf,
      outputFile: row.output_file,
      recordCount: Number(row.record_count),
      publicationStatus: row.publication_status,
      importedFrom: 'experimental-tss-metadata.tsv',
    })),
  ].join(', ')})`);
  const studyGenomes = parsed.rows.map((row) => `(${[
    sqlText(row.study_id), sqlText(genomeId(row)), sqlText(row.gcf),
  ].join(', ')})`);
  return [
    '-- Generated by scripts/database/build-experimental-tss-metadata-import.mjs.',
    insertSql('publications', [
      'publication_id', 'pmid', 'doi', 'title', 'authors_json', 'journal', 'publication_year', 'metadata_json',
    ], publications, 'ON CONFLICT(publication_id) DO UPDATE SET doi = excluded.doi, title = excluded.title, authors_json = excluded.authors_json, journal = excluded.journal, publication_year = excluded.publication_year, metadata_json = json_patch(publications.metadata_json, excluded.metadata_json)'),
    insertSql('genome_registry', [
      'genome_id', 'canonical_accession', 'reference_namespace', 'reference_accession', 'organism_name', 'source', 'provenance_json',
    ], genomes, 'ON CONFLICT(genome_id) DO UPDATE SET reference_accession = excluded.reference_accession, organism_name = excluded.organism_name, provenance_json = json_patch(genome_registry.provenance_json, excluded.provenance_json)'),
    insertSql('genome_aliases', ['genome_id', 'namespace', 'alias', 'relation'], aliases,
      'ON CONFLICT(namespace, alias) DO UPDATE SET genome_id = excluded.genome_id, relation = excluded.relation'),
    insertSql('experimental_studies', [
      'study_id', 'publication_id', 'source_id', 'source_version', 'study_year', 'provenance_json',
    ], studies, 'ON CONFLICT(study_id) DO UPDATE SET publication_id = excluded.publication_id, source_id = excluded.source_id, source_version = excluded.source_version, study_year = excluded.study_year, provenance_json = json_patch(experimental_studies.provenance_json, excluded.provenance_json)'),
    insertSql('experimental_study_genomes', ['study_id', 'genome_id', 'source_accession'], studyGenomes,
      'ON CONFLICT(study_id, genome_id) DO UPDATE SET source_accession = excluded.source_accession'),
    '',
  ].join('\n\n');
}

if (process.argv[1]?.endsWith('build-experimental-tss-metadata-import.mjs')) {
  const input = process.argv[2];
  if (!input) throw new Error('usage: node build-experimental-tss-metadata-import.mjs <metadata.tsv> [output.sql]');
  const output = process.argv[3] || join(tmpdir(), 'rapptor-experimental-tss-metadata.sql');
  const parsed = parseExperimentalTssMetadata(await readFile(input, 'utf8'));
  if (parsed.rows.length !== 98 || parsed.genomes.length !== 90 || parsed.publications.length !== 78) {
    throw new Error(`unexpected baseline: ${parsed.rows.length} studies, ${parsed.genomes.length} genomes, ${parsed.publications.length} publications`);
  }
  await writeFile(output, buildExperimentalTssMetadataSql(parsed), 'utf8');
  console.log(JSON.stringify({ output, studies: parsed.rows.length, genomes: parsed.genomes.length, publications: parsed.publications.length }));
}
