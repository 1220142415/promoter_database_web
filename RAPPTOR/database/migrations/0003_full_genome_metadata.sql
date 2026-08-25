PRAGMA foreign_keys = OFF;

ALTER TABLE releases ADD COLUMN dataset_version TEXT;
ALTER TABLE releases ADD COLUMN metadata_schema_version TEXT;
ALTER TABLE releases ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'ready'
  CHECK (publication_status IN ('staged', 'ready', 'retired'));

ALTER TABLE genomes ADD COLUMN ncbi_organism_name TEXT;
ALTER TABLE genomes ADD COLUMN ncbi_tax_id INTEGER CHECK (ncbi_tax_id IS NULL OR ncbi_tax_id >= 0);
ALTER TABLE genomes ADD COLUMN assembly_name TEXT;
ALTER TABLE genomes ADD COLUMN genbank_assembly_accession TEXT;
ALTER TABLE genomes ADD COLUMN refseq_assembly_accession TEXT;
ALTER TABLE genomes ADD COLUMN taxonomy_raw TEXT;
ALTER TABLE genomes ADD COLUMN species TEXT;
ALTER TABLE genomes ADD COLUMN taxonomy_source TEXT;
ALTER TABLE genomes ADD COLUMN gtdb_representative INTEGER CHECK (gtdb_representative IS NULL OR gtdb_representative IN (0, 1));
ALTER TABLE genomes ADD COLUMN gtdb_genome_representative TEXT;
ALTER TABLE genomes ADD COLUMN contig_n50 INTEGER CHECK (contig_n50 IS NULL OR contig_n50 >= 0);
ALTER TABLE genomes ADD COLUMN longest_contig_bp INTEGER CHECK (longest_contig_bp IS NULL OR longest_contig_bp >= 0);
ALTER TABLE genomes ADD COLUMN ambiguous_bases INTEGER CHECK (ambiguous_bases IS NULL OR ambiguous_bases >= 0);
ALTER TABLE genomes ADD COLUMN coding_density REAL CHECK (coding_density IS NULL OR coding_density BETWEEN 0 AND 100);
ALTER TABLE genomes ADD COLUMN protein_count INTEGER CHECK (protein_count IS NULL OR protein_count >= 0);
ALTER TABLE genomes ADD COLUMN trna_count INTEGER CHECK (trna_count IS NULL OR trna_count >= 0);
ALTER TABLE genomes ADD COLUMN ssu_rrna_count INTEGER CHECK (ssu_rrna_count IS NULL OR ssu_rrna_count >= 0);
ALTER TABLE genomes ADD COLUMN lsu_23s_rrna_count INTEGER CHECK (lsu_23s_rrna_count IS NULL OR lsu_23s_rrna_count >= 0);
ALTER TABLE genomes ADD COLUMN strain_heterogeneity REAL;
ALTER TABLE genomes ADD COLUMN mimag_quality TEXT CHECK (mimag_quality IS NULL OR mimag_quality IN ('high', 'medium', 'low'));
ALTER TABLE genomes ADD COLUMN assembly_source_url TEXT;

CREATE TABLE feature_definitions (
  release_id TEXT NOT NULL REFERENCES releases(release_id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL,
  feature_type TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  count_unit TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  configuration_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT,
  PRIMARY KEY (release_id, definition_id)
);

INSERT INTO feature_definitions (
  release_id, definition_id, feature_type, evidence_type, count_unit,
  source_id, source_version, configuration_json, generated_at
)
SELECT DISTINCT
  release_id,
  feature_type || ':' || source_id || ':' || source_version,
  feature_type, evidence_type, count_unit, source_id, source_version, '{}', NULL
FROM feature_sets;

DROP INDEX IF EXISTS feature_sets_one_default;
DROP INDEX IF EXISTS feature_sets_lookup;
DROP INDEX IF EXISTS feature_sets_count_sort;
ALTER TABLE feature_sets RENAME TO feature_sets_v2;

CREATE TABLE feature_sets (
  release_id TEXT NOT NULL,
  accession TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  feature_type TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  count_unit TEXT NOT NULL,
  feature_count INTEGER CHECK (feature_count IS NULL OR feature_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('staged', 'ready', 'missing', 'failed')),
  is_default INTEGER NOT NULL DEFAULT 1 CHECK (is_default IN (0, 1)),
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  detail_counts_json TEXT NOT NULL DEFAULT '{}',
  data_path TEXT,
  index_path TEXT,
  data_sha256 TEXT CHECK (data_sha256 IS NULL OR (length(data_sha256) = 64 AND data_sha256 NOT GLOB '*[^0-9a-f]*')),
  index_sha256 TEXT CHECK (index_sha256 IS NULL OR (length(index_sha256) = 64 AND index_sha256 NOT GLOB '*[^0-9a-f]*')),
  storage_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (release_id, accession, definition_id),
  FOREIGN KEY (release_id, accession)
    REFERENCES genomes(release_id, accession) ON DELETE CASCADE,
  FOREIGN KEY (release_id, definition_id)
    REFERENCES feature_definitions(release_id, definition_id) ON DELETE CASCADE,
  CHECK (
    (status = 'ready' AND feature_count IS NOT NULL AND data_path IS NOT NULL)
    OR (status = 'staged' AND feature_count IS NOT NULL)
    OR (status IN ('missing', 'failed'))
  )
);

INSERT INTO feature_sets (
  release_id, accession, definition_id, feature_type, evidence_type, count_unit,
  feature_count, status, is_default, source_id, source_version, provenance_json,
  detail_counts_json, data_path, index_path, data_sha256, index_sha256, storage_json
)
SELECT
  release_id, accession, feature_type || ':' || source_id || ':' || source_version,
  feature_type, evidence_type, count_unit, feature_count, status, is_default,
  source_id, source_version, provenance_json, '{}', data_path, index_path,
  NULL, NULL, storage_json
FROM feature_sets_v2;

DROP TABLE feature_sets_v2;

ALTER TABLE facet_options ADD COLUMN genome_count INTEGER NOT NULL DEFAULT 0
  CHECK (genome_count >= 0);

CREATE INDEX genomes_completeness_sort
  ON genomes(release_id, completeness, accession);
CREATE INDEX genomes_ncbi_tax_id
  ON genomes(release_id, ncbi_tax_id, accession);
CREATE UNIQUE INDEX feature_sets_one_default
  ON feature_sets(release_id, accession, feature_type)
  WHERE is_default = 1;
CREATE INDEX feature_sets_lookup
  ON feature_sets(release_id, accession, feature_type, is_default);
CREATE INDEX feature_sets_count_sort
  ON feature_sets(release_id, feature_type, is_default, feature_count, accession);
CREATE INDEX feature_definitions_type
  ON feature_definitions(release_id, feature_type);

PRAGMA foreign_keys = ON;
