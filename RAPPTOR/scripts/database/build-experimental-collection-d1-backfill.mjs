import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_ID = 'experimental-tss-hf-2026-08-28';
const REVISION = 'dde8d06cd82619e9dada766030511a81471ba9c3';
const ASSET_BASE = `https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes/resolve/${REVISION}/experimentally_supported_genomes`;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function sqlText(value) {
  return value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
}

function parseTsv(text) {
  const lines = text.replace(/^\uFEFF/u, '').trim().split(/\r?\n/u);
  const headers = lines.shift()?.split('\t') || [];
  if (!headers.length || new Set(headers).size !== headers.length) throw new Error('Invalid genome metadata header.');
  return lines.map((line) => {
    const fields = line.split('\t');
    if (fields.length !== headers.length) throw new Error('Invalid genome metadata row.');
    return Object.fromEntries(headers.map((header, index) => [header, fields[index]]));
  });
}

function parseChecksums(text) {
  const checksums = new Map();
  for (const line of text.trim().split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!match || checksums.has(match[2])) throw new Error(`Invalid checksum row: ${line}`);
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function safePath(value, label) {
  if (!value || !SAFE_PATH.test(value) || value.startsWith('/') || value.includes('..') || value.includes('//')) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

export function buildExperimentalCollectionD1BackfillSql(metadataText, checksumText) {
  const checksums = parseChecksums(checksumText);
  const genomes = parseTsv(metadataText).map((row) => {
    const accession = row.gcf;
    if (!/^GCF_\d{9}\.\d+$/u.test(accession)) throw new Error(`Invalid accession: ${accession}`);
    const promoterCount = Number(row.predicted_promoter_count);
    const cdsCount = Number(row.cds_count);
    if (![promoterCount, cdsCount].every((count) => Number.isSafeInteger(count) && count >= 0)) {
      throw new Error(`Invalid feature counts for ${accession}.`);
    }
    const fasta = safePath(row.genome_path, `${accession} FASTA path`);
    const promoter = safePath(row.promoter_path, `${accession} promoter path`);
    const annotation = safePath(row.annotation_path, `${accession} annotation path`);
    for (const path of [fasta, promoter, annotation]) {
      if (!checksums.has(path)) throw new Error(`Missing checksum for ${path}.`);
    }
    return { accession, promoterCount, cdsCount, fasta, promoter, annotation };
  });
  if (genomes.length !== 90 || new Set(genomes.map((genome) => genome.accession)).size !== 90) {
    throw new Error(`Expected 90 unique experimental genomes, received ${genomes.length}.`);
  }
  const tss = [...checksums].filter(([path]) => /^experimental_tss_by_study\/\d{4}_\d+_GCF_\d{9}\.\d+\.bed$/u.test(path));
  if (tss.length !== 98) throw new Error(`Expected 98 experimental TSS files, received ${tss.length}.`);
  const values = genomes.map((genome) => `(${[
    sqlText(genome.accession), genome.promoterCount, genome.cdsCount,
    sqlText(genome.fasta), sqlText(checksums.get(genome.fasta)),
    sqlText(genome.promoter), sqlText(checksums.get(genome.promoter)),
    sqlText(genome.annotation), sqlText(checksums.get(genome.annotation)),
  ].join(', ')})`).join(',\n');
  const tssValues = tss.map(([path, sha256]) => `(${sqlText(path.slice('experimental_tss_by_study/'.length, -4))}, ${sqlText(path)}, ${sqlText(sha256)})`).join(',\n');
  const release = sqlText(RELEASE_ID);
  const revision = sqlText(REVISION);
  const assetRows = `collection_assets(accession, promoter_count, cds_count, fasta_path, fasta_sha256, promoter_path, promoter_sha256, annotation_path, annotation_sha256) AS (VALUES\n${values}\n)`;

  return `PRAGMA foreign_keys = ON;

UPDATE releases
SET hf_revision = ${revision},
    source_release_id = ${sqlText(`Hugging Face ${REVISION}`)},
    release_asset_base_url = ${sqlText(ASSET_BASE)},
    manifest_index_path = 'manifest.tsv',
    dataset_version = 'experimentally-supported-genomes-2026-09-01',
    feature_summary_json = json_set(feature_summary_json,
      '$.annotationAvailable', 90,
      '$.collectionPromoterGenomes', 90,
      '$.referenceGenomes', 90)
WHERE release_id = ${release} AND release_kind = 'experimental_tss';

WITH ${assetRows}
UPDATE genomes
SET reference_storage_json = (SELECT json_object(
      'layout', 'individual-v1',
      'files', json_object('fasta', fasta_path),
      'checksums', json_object('fasta', fasta_sha256)
    ) FROM collection_assets WHERE collection_assets.accession = genomes.accession),
    reference_provenance_json = json_set(reference_provenance_json,
      '$.experimentalCollection', 'experimentally_supported_genomes',
      '$.sequencePath', (SELECT fasta_path FROM collection_assets WHERE collection_assets.accession = genomes.accession))
WHERE release_id = ${release}
  AND accession IN (SELECT accession FROM collection_assets);

UPDATE feature_sets
SET data_path = 'experimental_tss_by_study/' || definition_id || '.bed',
    index_path = NULL,
    provenance_json = json_set(provenance_json, '$.rawBedPath', 'experimental_tss_by_study/' || definition_id || '.bed'),
    storage_json = json_set(storage_json,
      '$.files.rawBed', 'experimental_tss_by_study/' || definition_id || '.bed',
      '$.files.data', 'experimental_tss_by_study/' || definition_id || '.bed',
      '$.files.index', NULL)
WHERE release_id = ${release} AND feature_type = 'experimental_tss';

WITH experimental_tss_files(definition_id, data_path, sha256) AS (VALUES
${tssValues}
)
UPDATE feature_sets
SET data_sha256 = (SELECT sha256 FROM experimental_tss_files WHERE experimental_tss_files.definition_id = feature_sets.definition_id)
WHERE release_id = ${release} AND feature_type = 'experimental_tss';

INSERT INTO feature_definitions (
  release_id, definition_id, feature_type, evidence_type, count_unit,
  source_id, source_version, configuration_json, generated_at
) VALUES
  (${release}, 'promoter:rapptor:experimental-hf', 'promoter', 'prediction', 'peak',
   'rapptor', ${revision}, json_object('collectionPath', 'promoter_predictions'), '2026-09-01T00:00:00Z'),
  (${release}, 'gene-annotation:eggnog:experimental-hf', 'gene_annotation', 'annotation', 'feature',
   'eggNOG-mapper', ${revision}, json_object('collectionPath', 'cds_function_annotations'), '2026-09-01T00:00:00Z')
ON CONFLICT(release_id, definition_id) DO UPDATE SET
  source_version = excluded.source_version,
  configuration_json = excluded.configuration_json,
  generated_at = excluded.generated_at;

WITH ${assetRows}
INSERT INTO feature_sets (
  release_id, accession, definition_id, feature_type, evidence_type, count_unit,
  feature_count, status, is_default, source_id, source_version,
  provenance_json, detail_counts_json, data_path, index_path,
  data_sha256, index_sha256, storage_json
)
SELECT
  ${release}, accession, 'promoter:rapptor:experimental-hf', 'promoter', 'prediction', 'peak',
  promoter_count, 'ready', 1, 'rapptor', ${revision},
  json_object('provider', 'RAPPTOR', 'collectionPath', promoter_path), json_object('peaks', promoter_count),
  promoter_path, NULL, promoter_sha256, NULL,
  json_object('layout', 'individual-v1', 'format', 'gff3', 'files', json_object('data', promoter_path, 'index', NULL))
FROM collection_assets WHERE true
ON CONFLICT(release_id, accession, definition_id) DO UPDATE SET
  feature_count = excluded.feature_count, status = excluded.status, source_version = excluded.source_version,
  provenance_json = excluded.provenance_json, detail_counts_json = excluded.detail_counts_json,
  data_path = excluded.data_path, index_path = excluded.index_path,
  data_sha256 = excluded.data_sha256, index_sha256 = excluded.index_sha256,
  storage_json = excluded.storage_json;

WITH ${assetRows}
INSERT INTO feature_sets (
  release_id, accession, definition_id, feature_type, evidence_type, count_unit,
  feature_count, status, is_default, source_id, source_version,
  provenance_json, detail_counts_json, data_path, index_path,
  data_sha256, index_sha256, storage_json
)
SELECT
  ${release}, accession, 'gene-annotation:eggnog:experimental-hf', 'gene_annotation', 'annotation', 'feature',
  cds_count, 'ready', 1, 'eggNOG-mapper', ${revision},
  json_object('provider', 'Prodigal / eggNOG-mapper', 'collectionPath', annotation_path), json_object('CDS', cds_count),
  annotation_path, NULL, annotation_sha256, NULL,
  json_object('layout', 'individual-v1', 'format', 'gff3', 'files', json_object('data', annotation_path, 'index', NULL))
FROM collection_assets WHERE true
ON CONFLICT(release_id, accession, definition_id) DO UPDATE SET
  feature_count = excluded.feature_count, status = excluded.status, source_version = excluded.source_version,
  provenance_json = excluded.provenance_json, detail_counts_json = excluded.detail_counts_json,
  data_path = excluded.data_path, index_path = excluded.index_path,
  data_sha256 = excluded.data_sha256, index_sha256 = excluded.index_sha256,
  storage_json = excluded.storage_json;

WITH ${assetRows}, collection_asset_rows AS (
  SELECT release_genomes.genome_id, collection_assets.*
  FROM collection_assets
  JOIN release_genomes ON release_genomes.release_id = ${release}
    AND release_genomes.accession = collection_assets.accession
)
INSERT INTO assets (
  asset_id, genome_id, release_id, accession, definition_id, study_id,
  asset_type, location, sha256, status, metadata_json
)
SELECT ${release} || ':' || accession || ':reference:fasta', genome_id, ${release}, accession, NULL, NULL,
  'reference_fasta', fasta_path, fasta_sha256, 'ready', '{}'
FROM collection_asset_rows
UNION ALL
SELECT ${release} || ':' || accession || ':promoter:data', genome_id, ${release}, accession,
  'promoter:rapptor:experimental-hf', NULL, 'promoter_data', promoter_path, promoter_sha256, 'ready', '{}'
FROM collection_asset_rows
UNION ALL
SELECT ${release} || ':' || accession || ':annotation:data', genome_id, ${release}, accession,
  'gene-annotation:eggnog:experimental-hf', NULL, 'gene_annotation_data', annotation_path, annotation_sha256, 'ready', '{}'
FROM collection_asset_rows WHERE true
ON CONFLICT(asset_id) DO UPDATE SET
  location = excluded.location, sha256 = excluded.sha256, status = excluded.status;

SELECT COUNT(*) AS genomes,
       SUM(json_extract(reference_storage_json, '$.files.fasta') IS NOT NULL) AS fasta_paths
FROM genomes WHERE release_id = ${release};
SELECT feature_type, status, COUNT(*) AS rows, SUM(data_path IS NOT NULL) AS stored_paths
FROM feature_sets WHERE release_id = ${release}
GROUP BY feature_type, status ORDER BY feature_type, status;
`;
}

async function main() {
  const metadataPath = resolve(process.argv[2] || '.data/experimental-collection/metadata/genomes.tsv');
  const checksumPath = resolve(process.argv[3] || '.data/experimental-collection/checksums.sha256');
  const outputPath = resolve(process.argv[4] || '.data/d1-imports/experimental-tss-hf-2026-08-28/backfill-collection-assets.sql');
  const sql = buildExperimentalCollectionD1BackfillSql(
    await readFile(metadataPath, 'utf8'),
    await readFile(checksumPath, 'utf8'),
  );
  await writeFile(outputPath, sql, 'utf8');
  console.log(JSON.stringify({ outputPath, releaseId: RELEASE_ID, revision: REVISION }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
