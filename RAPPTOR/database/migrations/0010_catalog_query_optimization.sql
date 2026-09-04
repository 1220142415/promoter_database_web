-- Fixed release metadata and lookup indexes used by the public catalog.

CREATE INDEX IF NOT EXISTS release_genomes_release_identity
  ON release_genomes(release_id, genome_id, accession);

CREATE INDEX IF NOT EXISTS feature_sets_status_lookup
  ON feature_sets(release_id, feature_type, is_default, status, accession);

UPDATE releases
SET feature_summary_json = json_set(feature_summary_json, '$.totalExperimentalGenomes', 0)
WHERE COALESCE(release_kind, 'prediction') = 'prediction'
  AND json_type(feature_summary_json, '$.totalExperimentalGenomes') IS NULL;
