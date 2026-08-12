PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS releases (
  release_id TEXT PRIMARY KEY,
  source_release_id TEXT,
  release_date TEXT,
  generated_at TEXT,
  description TEXT,
  layout TEXT NOT NULL CHECK (layout IN ('individual-v1', 'packed-v1')),
  hf_repository TEXT,
  hf_revision TEXT NOT NULL DEFAULT 'main',
  release_asset_base_url TEXT,
  manifest_index_path TEXT,
  total_genomes INTEGER NOT NULL,
  total_predicted_promoters INTEGER NOT NULL,
  total_annotated_genomes INTEGER NOT NULL,
  total_downloaded_annotations INTEGER NOT NULL,
  total_missing_annotations INTEGER NOT NULL,
  total_incompatible_annotations INTEGER NOT NULL,
  total_usable_annotations INTEGER NOT NULL,
  total_circular_origin_split_features INTEGER NOT NULL DEFAULT 0,
  total_circular_origin_split_genomes INTEGER NOT NULL DEFAULT 0,
  total_experimental_tss INTEGER NOT NULL DEFAULT 0,
  top_phyla_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN ('inactive', 'active', 'retired'))
);

CREATE TABLE IF NOT EXISTS portal_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_release_id TEXT NOT NULL REFERENCES releases(release_id)
);

CREATE TABLE IF NOT EXISTS genomes (
  release_id TEXT NOT NULL REFERENCES releases(release_id),
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
  genome_size_bp INTEGER,
  gc_content REAL,
  contig_count INTEGER,
  completeness REAL,
  contamination REAL,
  predicted_promoter_count INTEGER NOT NULL,
  annotation_status TEXT NOT NULL CHECK (annotation_status IN ('available', 'missing', 'incompatible')),
  annotation_feature_count INTEGER NOT NULL,
  annotation_circular_origin_split_count INTEGER NOT NULL DEFAULT 0,
  experimental_tss_count INTEGER NOT NULL DEFAULT 0,
  has_experimental_tss INTEGER NOT NULL DEFAULT 0,
  default_locus TEXT,
  primary_sequence TEXT,
  logical_object_prefix TEXT NOT NULL,
  assets_json TEXT NOT NULL,
  storage_json TEXT NOT NULL,
  PRIMARY KEY (release_id, accession)
);

CREATE TABLE IF NOT EXISTS genome_search_terms (
  release_id TEXT NOT NULL,
  accession TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (release_id, accession, token),
  FOREIGN KEY (release_id, accession) REFERENCES genomes(release_id, accession) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS facet_options (
  release_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  phylum TEXT NOT NULL DEFAULT '',
  class_name TEXT NOT NULL DEFAULT '',
  order_name TEXT NOT NULL DEFAULT '',
  family TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (release_id, kind, value, domain, phylum, class_name, order_name, family)
);

CREATE INDEX IF NOT EXISTS genomes_accession_sort ON genomes(release_id, accession);
CREATE INDEX IF NOT EXISTS genomes_organism_sort ON genomes(release_id, organism_name, accession);
CREATE INDEX IF NOT EXISTS genomes_organism_sort_desc ON genomes(release_id, organism_name DESC, accession ASC);
CREATE INDEX IF NOT EXISTS genomes_size_sort ON genomes(release_id, genome_size_bp IS NULL, genome_size_bp, accession);
CREATE INDEX IF NOT EXISTS genomes_size_sort_desc ON genomes(release_id, genome_size_bp IS NULL ASC, genome_size_bp DESC, accession ASC);
CREATE INDEX IF NOT EXISTS genomes_promoter_sort ON genomes(release_id, predicted_promoter_count, accession);
CREATE INDEX IF NOT EXISTS genomes_promoter_sort_desc ON genomes(release_id, predicted_promoter_count DESC, accession ASC);
CREATE INDEX IF NOT EXISTS genomes_taxonomy ON genomes(release_id, domain, phylum, class_name, order_name, family, genus, accession);
CREATE INDEX IF NOT EXISTS genomes_source_annotation ON genomes(release_id, genome_source, annotation_status, accession);
CREATE INDEX IF NOT EXISTS genome_search_token ON genome_search_terms(release_id, token, accession);
CREATE INDEX IF NOT EXISTS facet_options_lookup ON facet_options(release_id, kind, domain, phylum, class_name, order_name, family, value);
