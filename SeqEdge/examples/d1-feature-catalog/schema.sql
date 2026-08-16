PRAGMA foreign_keys = ON;

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
