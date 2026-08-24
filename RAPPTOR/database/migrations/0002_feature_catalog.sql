PRAGMA foreign_keys = OFF;

ALTER TABLE portal_state RENAME TO portal_state_v1;
ALTER TABLE genome_search_terms RENAME TO genome_search_terms_v1;
ALTER TABLE facet_options RENAME TO facet_options_v1;
ALTER TABLE genomes RENAME TO genomes_v1;
ALTER TABLE releases RENAME TO releases_v1;

DROP INDEX IF EXISTS genomes_accession_sort;
DROP INDEX IF EXISTS genomes_organism_sort;
DROP INDEX IF EXISTS genomes_organism_sort_desc;
DROP INDEX IF EXISTS genomes_size_sort;
DROP INDEX IF EXISTS genomes_size_sort_desc;
DROP INDEX IF EXISTS genomes_promoter_sort;
DROP INDEX IF EXISTS genomes_promoter_sort_desc;
DROP INDEX IF EXISTS genomes_taxonomy;
DROP INDEX IF EXISTS genomes_source_annotation;
DROP INDEX IF EXISTS genome_search_token;
DROP INDEX IF EXISTS facet_options_lookup;

CREATE TABLE releases (
  release_id TEXT PRIMARY KEY,
  source_release_id TEXT,
  release_date TEXT,
  generated_at TEXT,
  description TEXT,
  storage_layout TEXT NOT NULL CHECK (storage_layout IN ('individual-v1', 'packed-v1')),
  hf_repository TEXT,
  hf_revision TEXT NOT NULL DEFAULT 'main',
  release_asset_base_url TEXT,
  manifest_index_path TEXT,
  total_genomes INTEGER NOT NULL CHECK (total_genomes >= 0),
  feature_summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE portal_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_release_id TEXT NOT NULL REFERENCES releases(release_id)
);

CREATE TABLE genomes (
  release_id TEXT NOT NULL REFERENCES releases(release_id) ON DELETE CASCADE,
  accession TEXT NOT NULL,
  organism_name TEXT NOT NULL,
  strain TEXT,
  domain TEXT,
  phylum TEXT,
  class_name TEXT,
  order_name TEXT,
  family TEXT,
  genus TEXT,
  genome_source TEXT,
  assembly_level TEXT,
  genome_size_bp INTEGER CHECK (genome_size_bp IS NULL OR genome_size_bp >= 0),
  gc_content REAL CHECK (gc_content IS NULL OR gc_content BETWEEN 0 AND 100),
  contig_count INTEGER CHECK (contig_count IS NULL OR contig_count >= 0),
  completeness REAL,
  contamination REAL,
  default_locus TEXT,
  primary_sequence TEXT,
  reference_storage_json TEXT NOT NULL,
  PRIMARY KEY (release_id, accession)
);

CREATE TABLE feature_sets (
  release_id TEXT NOT NULL,
  accession TEXT NOT NULL,
  feature_type TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  count_unit TEXT NOT NULL,
  feature_count INTEGER CHECK (feature_count IS NULL OR feature_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('ready', 'missing', 'failed')),
  is_default INTEGER NOT NULL DEFAULT 1 CHECK (is_default IN (0, 1)),
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  data_path TEXT,
  index_path TEXT,
  storage_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (release_id, accession, feature_type, source_id, source_version),
  FOREIGN KEY (release_id, accession)
    REFERENCES genomes(release_id, accession) ON DELETE CASCADE,
  CHECK (
    (status = 'ready' AND feature_count IS NOT NULL AND data_path IS NOT NULL)
    OR (status IN ('missing', 'failed'))
  )
);

CREATE TABLE genome_search_terms (
  release_id TEXT NOT NULL,
  accession TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (release_id, accession, token),
  FOREIGN KEY (release_id, accession)
    REFERENCES genomes(release_id, accession) ON DELETE CASCADE
);

CREATE TABLE facet_options (
  release_id TEXT NOT NULL REFERENCES releases(release_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  phylum TEXT NOT NULL DEFAULT '',
  class_name TEXT NOT NULL DEFAULT '',
  order_name TEXT NOT NULL DEFAULT '',
  family TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (release_id, kind, value, domain, phylum, class_name, order_name, family)
);

INSERT INTO releases (
  release_id, source_release_id, release_date, generated_at, description,
  storage_layout, hf_repository, hf_revision, release_asset_base_url,
  manifest_index_path, total_genomes, feature_summary_json
)
SELECT
  release_id, source_release_id, release_date, generated_at, description,
  layout, hf_repository, hf_revision, release_asset_base_url,
  manifest_index_path, total_genomes,
  json_object(
    'totalCircularOriginSplitFeatures', total_circular_origin_split_features,
    'totalCircularOriginSplitGenomes', total_circular_origin_split_genomes,
    'totalExperimentalTss', total_experimental_tss,
    'topPhyla', json(top_phyla_json)
  )
FROM releases_v1;

INSERT INTO genomes (
  release_id, accession, organism_name, strain, domain, phylum, class_name,
  order_name, family, genus, genome_source, assembly_level, genome_size_bp,
  gc_content, contig_count, completeness, contamination, default_locus,
  primary_sequence, reference_storage_json
)
SELECT
  release_id, accession, organism_name, strain, domain, phylum, class_name,
  order_name, family, genus, genome_source, assembly_level, genome_size_bp,
  gc_content, contig_count, completeness, contamination, default_locus,
  primary_sequence,
  CASE
    WHEN json_extract(storage_json, '$.layout') = 'packed-v1' THEN storage_json
    ELSE json_set(
      storage_json,
      '$.files', json_object(
        'fasta', json_extract(assets_json, '$.fasta'),
        'fai', json_extract(assets_json, '$.fastaFai'),
        'gzi', json_extract(assets_json, '$.fastaGzi'),
        'metadata', json_extract(assets_json, '$.metadata')
      )
    )
  END
FROM genomes_v1;

INSERT INTO feature_sets (
  release_id, accession, feature_type, evidence_type, count_unit,
  feature_count, status, is_default, source_id, source_version,
  provenance_json, data_path, index_path, storage_json
)
SELECT
  release_id, accession, 'promoter', 'prediction', 'peak',
  predicted_promoter_count, 'ready', 1, 'rapptor', 'unrecorded', '{}',
  CASE
    WHEN json_extract(storage_json, '$.layout') = 'packed-v1' THEN accession || '/predicted-promoters.gff3.gz'
    ELSE json_extract(assets_json, '$.predictedPromoters')
  END,
  CASE
    WHEN json_extract(storage_json, '$.layout') = 'packed-v1' THEN accession || '/predicted-promoters.gff3.gz.tbi'
    ELSE json_extract(assets_json, '$.predictedPromotersIndex')
  END,
  CASE WHEN json_extract(storage_json, '$.layout') = 'packed-v1' THEN storage_json ELSE '{}' END
FROM genomes_v1
WHERE json_extract(assets_json, '$.predictedPromoters') IS NOT NULL
   OR json_type(storage_json, '$.assets."predicted-promoters.gff3.gz"') IS NOT NULL;

INSERT INTO feature_sets (
  release_id, accession, feature_type, evidence_type, count_unit,
  feature_count, status, is_default, source_id, source_version,
  provenance_json, data_path, index_path, storage_json
)
SELECT
  release_id, accession, 'gene_annotation', 'annotation', 'feature',
  CASE WHEN annotation_status = 'available' THEN annotation_feature_count ELSE NULL END,
  CASE annotation_status WHEN 'available' THEN 'ready' WHEN 'incompatible' THEN 'failed' ELSE 'missing' END,
  1, 'ncbi', 'unrecorded', '{}',
  CASE
    WHEN annotation_status <> 'available' THEN NULL
    WHEN json_extract(storage_json, '$.layout') = 'packed-v1' THEN accession || '/ncbi-annotations.gff3.gz'
    ELSE json_extract(assets_json, '$.ncbiAnnotations')
  END,
  CASE
    WHEN annotation_status <> 'available' THEN NULL
    WHEN json_extract(storage_json, '$.layout') = 'packed-v1' THEN accession || '/ncbi-annotations.gff3.gz.tbi'
    ELSE json_extract(assets_json, '$.ncbiAnnotationsIndex')
  END,
  CASE WHEN json_extract(storage_json, '$.layout') = 'packed-v1' THEN storage_json ELSE '{}' END
FROM genomes_v1;

INSERT INTO genome_search_terms SELECT * FROM genome_search_terms_v1;
INSERT INTO facet_options SELECT * FROM facet_options_v1;
INSERT INTO portal_state SELECT * FROM portal_state_v1;

DROP TABLE portal_state_v1;
DROP TABLE genome_search_terms_v1;
DROP TABLE facet_options_v1;
DROP TABLE genomes_v1;
DROP TABLE releases_v1;

CREATE INDEX genomes_organism_sort
  ON genomes(release_id, organism_name, accession);
CREATE INDEX genomes_size_sort
  ON genomes(release_id, genome_size_bp, accession);
CREATE INDEX genomes_taxonomy
  ON genomes(release_id, domain, phylum, class_name, order_name, family, genus, accession);
CREATE UNIQUE INDEX feature_sets_one_default
  ON feature_sets(release_id, accession, feature_type)
  WHERE is_default = 1;
CREATE INDEX feature_sets_lookup
  ON feature_sets(release_id, accession, feature_type, is_default);
CREATE INDEX feature_sets_count_sort
  ON feature_sets(release_id, feature_type, is_default, feature_count, accession);
CREATE INDEX genome_search_token
  ON genome_search_terms(release_id, token, accession);
CREATE INDEX facet_options_lookup
  ON facet_options(release_id, kind, domain, phylum, class_name, order_name, family, value);

PRAGMA foreign_keys = ON;
