import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RELEASE_ID = 'experimental-tss-hf-2026-08-28';
const DEFAULT_REPOSITORY = 'liurulong/bacterial-promoter-genomes';
const DEFAULT_REVISION = '9db0aa5cf61c66fb88ee1ebbd5663a8825c020da';

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function releaseValues(options) {
  const repository = options.repository || DEFAULT_REPOSITORY;
  const revision = options.revision || DEFAULT_REVISION;
  const releaseId = options.releaseId || DEFAULT_RELEASE_ID;
  const releaseDate = options.releaseDate || '2026-08-28';
  const generatedAt = options.generatedAt || `${releaseDate}T00:00:00Z`;
  if (!/^[a-z0-9][a-z0-9._-]+$/i.test(releaseId)) throw new Error('Invalid release ID.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid Hugging Face repository.');
  if (!/^[0-9a-f]{40}$/.test(revision) && revision !== 'main') throw new Error('Invalid Hugging Face revision.');
  return {
    releaseId,
    releaseDate,
    generatedAt,
    repository,
    revision,
    assetBase: `https://huggingface.co/datasets/${repository}/resolve/${revision}`,
  };
}

export function buildExperimentalTssHfReleaseSql(options = {}) {
  const value = releaseValues(options);
  const release = sqlText(value.releaseId);
  const assetBase = sqlText(value.assetBase);
  const generatedAt = sqlText(value.generatedAt);
  return `PRAGMA foreign_keys = ON;

-- A rerun may replace only an unactivated staged build.
DELETE FROM releases
WHERE release_id = ${release} AND publication_status = 'staged';

INSERT INTO releases (
  release_id, source_release_id, release_date, generated_at, description,
  storage_layout, hf_repository, hf_revision, release_asset_base_url,
  manifest_index_path, total_genomes, feature_summary_json,
  dataset_version, metadata_schema_version, publication_status, release_kind
) VALUES (
  ${release}, ${sqlText(`Hugging Face ${value.revision}`)}, ${sqlText(value.releaseDate)}, ${generatedAt},
  'Published experimental TSS studies matched by stable NCBI assembly identity.',
  'individual-v1', ${sqlText(value.repository)}, ${sqlText(value.revision)}, ${assetBase},
  'experimentally_supported_tss_by_study/manifest.tsv', 90,
  json_object(
    'studies', 98, 'genomes', 90, 'publications', 78, 'observations', 440947,
    'experimentalStudies', 98, 'experimentalTss', 440947,
    'matchedPredictionGenomes', 29
  ),
  'experimental-tss-metadata-2026-08-28', 'experimental-tss-hf-v1', 'staged', 'experimental_tss'
);

WITH source_genomes AS (
  SELECT esg.genome_id, MIN(esg.source_accession) AS accession
  FROM experimental_study_genomes esg
  GROUP BY esg.genome_id
)
INSERT INTO genomes (
  release_id, accession, organism_name, strain, domain, phylum, class_name,
  order_name, family, genus, genome_source, assembly_level, genome_size_bp,
  gc_content, contig_count, predicted_promoter_count, default_locus, primary_sequence, reference_storage_json,
  ncbi_organism_name, ncbi_tax_id, assembly_name, genbank_assembly_accession,
  refseq_assembly_accession, taxonomy_raw, species, taxonomy_source,
  assembly_source_url, reference_namespace, reference_accession,
  reference_provenance_json
)
SELECT
  ${release}, source.accession, registry.organism_name,
  COALESCE(prediction.strain, json_extract(registry.provenance_json, '$.strain')),
  prediction.domain, prediction.phylum, prediction.class_name, prediction.order_name,
  prediction.family, prediction.genus, 'experimental_tss',
  COALESCE(prediction.assembly_level, json_extract(registry.provenance_json, '$.assemblyLevel')),
  COALESCE(prediction.genome_size_bp, CAST(json_extract(registry.provenance_json, '$.genomeSizeBp') AS INTEGER)),
  COALESCE(prediction.gc_content, CAST(json_extract(registry.provenance_json, '$.gcPercent') AS REAL)),
  COALESCE(prediction.contig_count, CAST(json_extract(registry.provenance_json, '$.contigCount') AS INTEGER)),
  COALESCE(prediction.predicted_promoter_count, 0),
  prediction.default_locus, prediction.primary_sequence,
  COALESCE(prediction.reference_storage_json, '{}'),
  COALESCE(prediction.ncbi_organism_name, registry.organism_name),
  COALESCE(prediction.ncbi_tax_id, CAST(json_extract(registry.provenance_json, '$.taxId') AS INTEGER)),
  COALESCE(prediction.assembly_name, json_extract(registry.provenance_json, '$.assemblyName')),
  COALESCE(prediction.genbank_assembly_accession, json_extract(registry.provenance_json, '$.genbankAssemblyAccession')),
  COALESCE(prediction.refseq_assembly_accession, registry.reference_accession),
  prediction.taxonomy_raw, prediction.species,
  CASE WHEN prediction_identity.genome_id IS NULL THEN 'NCBI assembly metadata' ELSE prediction.taxonomy_source END,
  prediction.assembly_source_url, registry.reference_namespace, registry.reference_accession,
  json_set(
    registry.provenance_json,
    '$.gtdbMatch', CASE WHEN prediction_identity.genome_id IS NULL THEN 'not_in_active_prediction_release' ELSE 'exact_assembly_identity' END,
    '$.experimentalSourceAccession', source.accession
  )
FROM source_genomes source
JOIN genome_registry registry ON registry.genome_id = source.genome_id
LEFT JOIN portal_state prediction_state ON prediction_state.singleton = 1
LEFT JOIN release_genomes prediction_identity
  ON prediction_identity.release_id = prediction_state.active_release_id
 AND prediction_identity.genome_id = source.genome_id
LEFT JOIN genomes prediction
  ON prediction.release_id = prediction_identity.release_id
 AND prediction.accession = prediction_identity.accession;

INSERT INTO release_genomes (release_id, accession, genome_id)
SELECT ${release}, MIN(source_accession), genome_id
FROM experimental_study_genomes
GROUP BY genome_id;

-- Experimental genomes without an active prediction identity stay searchable;
-- their prediction feature is explicitly missing until a later release backfills it.
INSERT INTO feature_definitions (
  release_id, definition_id, feature_type, evidence_type, count_unit,
  source_id, source_version, configuration_json, generated_at
) VALUES (
  ${release}, 'promoter:rapptor:experimental-hf', 'promoter', 'prediction', 'peak',
  'rapptor', ${sqlText(value.revision)}, json_object('assetStatus', 'missing'), ${generatedAt}
);

INSERT INTO feature_sets (
  release_id, accession, definition_id, feature_type, evidence_type, count_unit,
  feature_count, status, is_default, source_id, source_version,
  provenance_json, data_path, index_path, storage_json
)
SELECT
  ${release}, g.accession, 'promoter:rapptor:experimental-hf', 'promoter', 'prediction', 'peak',
  NULL, 'missing', 1, 'rapptor', ${sqlText(value.revision)},
  json_object('reason', 'prediction_not_in_active_release', 'assetStatus', 'missing'),
  NULL, NULL, '{}'
FROM genomes g
WHERE g.release_id = ${release}
  AND NOT EXISTS (
    SELECT 1
    FROM release_genomes current_experimental
    JOIN release_genomes active_prediction
      ON active_prediction.genome_id = current_experimental.genome_id
    JOIN portal_state prediction_state ON prediction_state.singleton = 1
    WHERE current_experimental.release_id = ${release}
      AND current_experimental.accession = g.accession
      AND active_prediction.release_id = prediction_state.active_release_id
  );

INSERT INTO feature_definitions (
  release_id, definition_id, feature_type, evidence_type, count_unit,
  source_id, source_version, configuration_json, generated_at
)
SELECT
  ${release}, study.study_id, 'experimental_tss', 'experimental', 'observation',
  study.source_id, study.source_version,
  json_object(
    'pmid', publication.pmid,
    'year', study.study_year,
    'publication', json_object(
      'title', publication.title,
      'authors', json(publication.authors_json),
      'journal', publication.journal,
      'doi', publication.doi,
      'status', COALESCE(json_extract(publication.metadata_json, '$.status'), 'unresolved')
    )
  ),
  ${generatedAt}
FROM experimental_studies study
LEFT JOIN publications publication ON publication.publication_id = study.publication_id;

WITH study_rows AS (
  SELECT
    link.source_accession AS accession,
    study.*,
    json_extract(study.provenance_json, '$.outputFile') AS output_file,
    CAST(json_extract(study.provenance_json, '$.recordCount') AS INTEGER) AS record_count,
    ROW_NUMBER() OVER (PARTITION BY link.source_accession ORDER BY study.study_id) AS study_rank
  FROM experimental_studies study
  JOIN experimental_study_genomes link ON link.study_id = study.study_id
)
INSERT INTO feature_sets (
  release_id, accession, definition_id, feature_type, evidence_type, count_unit,
  feature_count, status, is_default, source_id, source_version,
  provenance_json, detail_counts_json, data_path, index_path,
  data_sha256, index_sha256, storage_json
)
SELECT
  ${release}, accession, study_id, 'experimental_tss', 'experimental', 'observation',
  record_count, 'ready', CASE WHEN study_rank = 1 THEN 1 ELSE 0 END,
  source_id, source_version,
  json_set(
    provenance_json,
    '$.rawBedPath', 'experimentally_supported_tss_by_study/' || output_file,
    '$.sourceFile', source_id,
    '$.sourceSha256', source_version,
    '$.gtdbMatchPolicy', 'stable_genome_id_only'
  ),
  json_object('sourceAccession', accession),
  'experimentally_supported_tss_by_study/' || output_file,
  NULL, source_version, NULL,
  json_object(
    'layout', 'individual-v1', 'format', 'bed',
    'transform', 'experimental-bed-to-gff3-v1',
    'files', json_object(
      'rawBed', 'experimentally_supported_tss_by_study/' || output_file,
      'data', 'experimentally_supported_tss_by_study/' || output_file,
      'index', NULL
    )
  )
FROM study_rows;
`;
}

export function buildExperimentalTssHfValidationSql(options = {}) {
  const release = sqlText(releaseValues(options).releaseId);
  return `SELECT release_id, publication_status, total_genomes, feature_summary_json
FROM releases WHERE release_id = ${release};
SELECT COUNT(*) AS genomes FROM genomes WHERE release_id = ${release};
SELECT COUNT(*) AS release_genomes FROM release_genomes WHERE release_id = ${release};
SELECT COUNT(*) AS studies, COUNT(DISTINCT accession) AS study_genomes,
       COUNT(DISTINCT json_extract(configuration_json, '$.pmid')) AS publications,
       SUM(feature_count) AS observations
FROM feature_sets JOIN feature_definitions USING (release_id, definition_id)
WHERE release_id = ${release} AND feature_sets.feature_type = 'experimental_tss';
SELECT COUNT(*) AS matched_prediction_genomes
FROM release_genomes experimental
JOIN portal_state prediction_state ON prediction_state.singleton = 1
JOIN release_genomes prediction
  ON prediction.release_id = prediction_state.active_release_id
 AND prediction.genome_id = experimental.genome_id
WHERE experimental.release_id = ${release};
SELECT COUNT(*) AS missing_prediction_features
FROM feature_sets
WHERE release_id = ${release}
  AND feature_type = 'promoter'
  AND evidence_type = 'prediction'
  AND status = 'missing';
`;
}

export function buildExperimentalTssHfActivationSql(options = {}) {
  const release = sqlText(releaseValues(options).releaseId);
  return `UPDATE releases SET publication_status = 'ready' WHERE release_id = ${release};
INSERT INTO experimental_portal_state (singleton, active_release_id)
VALUES (1, ${release})
ON CONFLICT(singleton) DO UPDATE SET active_release_id = excluded.active_release_id;
`;
}

async function main() {
  const output = resolve(process.argv[2] || '.data/d1-imports/experimental-tss-hf-2026-08-28');
  const options = {};
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(resolve(output, 'apply.sql'), buildExperimentalTssHfReleaseSql(options), 'utf8'),
    writeFile(resolve(output, 'validate.sql'), buildExperimentalTssHfValidationSql(options), 'utf8'),
    writeFile(resolve(output, 'activate.sql'), buildExperimentalTssHfActivationSql(options), 'utf8'),
  ]);
  console.log(JSON.stringify({ output, releaseId: DEFAULT_RELEASE_ID, revision: DEFAULT_REVISION }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
