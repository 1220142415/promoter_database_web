PRAGMA foreign_keys = ON;

-- Stable genome identity shared by prediction, annotation, and experimental releases.
CREATE TABLE genome_registry (
  genome_id TEXT PRIMARY KEY,
  canonical_accession TEXT NOT NULL,
  reference_namespace TEXT NOT NULL,
  reference_accession TEXT NOT NULL,
  reference_sha256 TEXT CHECK (
    reference_sha256 IS NULL OR
    (length(reference_sha256) = 64 AND reference_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  organism_name TEXT NOT NULL,
  source TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),
  UNIQUE (reference_namespace, canonical_accession)
);

CREATE TABLE genome_aliases (
  genome_id TEXT NOT NULL REFERENCES genome_registry(genome_id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  alias TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (namespace, alias)
);

CREATE TABLE publications (
  publication_id TEXT PRIMARY KEY,
  pmid TEXT UNIQUE,
  doi TEXT,
  title TEXT,
  authors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(authors_json)),
  journal TEXT,
  publication_year INTEGER CHECK (publication_year IS NULL OR publication_year >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);

CREATE TABLE experimental_studies (
  study_id TEXT PRIMARY KEY,
  publication_id TEXT REFERENCES publications(publication_id),
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  study_year INTEGER CHECK (study_year IS NULL OR study_year >= 0),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json))
);

CREATE TABLE experimental_study_genomes (
  study_id TEXT NOT NULL REFERENCES experimental_studies(study_id) ON DELETE CASCADE,
  genome_id TEXT NOT NULL REFERENCES genome_registry(genome_id) ON DELETE CASCADE,
  source_accession TEXT NOT NULL,
  PRIMARY KEY (study_id, genome_id)
);

CREATE TABLE release_genomes (
  release_id TEXT NOT NULL,
  accession TEXT NOT NULL,
  genome_id TEXT NOT NULL REFERENCES genome_registry(genome_id),
  PRIMARY KEY (release_id, accession),
  FOREIGN KEY (release_id, accession)
    REFERENCES genomes(release_id, accession) ON DELETE CASCADE
);

CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  genome_id TEXT NOT NULL REFERENCES genome_registry(genome_id),
  release_id TEXT NOT NULL,
  accession TEXT NOT NULL,
  definition_id TEXT,
  study_id TEXT REFERENCES experimental_studies(study_id),
  asset_type TEXT NOT NULL,
  location TEXT NOT NULL,
  sha256 TEXT CHECK (
    sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  status TEXT NOT NULL CHECK (status IN ('staged', 'ready', 'missing', 'failed')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  FOREIGN KEY (release_id, accession)
    REFERENCES release_genomes(release_id, accession) ON DELETE CASCADE,
  FOREIGN KEY (release_id, definition_id)
    REFERENCES feature_definitions(release_id, definition_id) ON DELETE CASCADE
);

CREATE INDEX genome_aliases_genome ON genome_aliases(genome_id);
CREATE INDEX release_genomes_identity ON release_genomes(genome_id, release_id);
CREATE INDEX experimental_studies_publication ON experimental_studies(publication_id);
CREATE INDEX experimental_study_genomes_genome ON experimental_study_genomes(genome_id, study_id);
CREATE INDEX assets_genome_type ON assets(genome_id, asset_type, release_id);
CREATE INDEX assets_release_feature ON assets(release_id, accession, definition_id);

-- Prefer the GenBank member of an NCBI reciprocal assembly pair as the stable ID.
WITH identities AS (
  SELECT
    'ncbi_assembly:' || COALESCE(
      NULLIF(trim(genbank_assembly_accession), ''),
      NULLIF(trim(refseq_assembly_accession), ''),
      NULLIF(trim(reference_accession), ''),
      accession
    ) AS genome_id,
    COALESCE(
      NULLIF(trim(genbank_assembly_accession), ''),
      NULLIF(trim(refseq_assembly_accession), ''),
      NULLIF(trim(reference_accession), ''),
      accession
    ) AS canonical_accession,
    COALESCE(NULLIF(trim(reference_namespace), ''), 'ncbi_assembly') AS reference_namespace,
    COALESCE(NULLIF(trim(reference_accession), ''), accession) AS reference_accession,
    organism_name,
    COALESCE(NULLIF(trim(genome_source), ''), 'unknown') AS source,
    release_id,
    accession
  FROM genomes
)
INSERT OR IGNORE INTO genome_registry (
  genome_id, canonical_accession, reference_namespace, reference_accession,
  organism_name, source, provenance_json
)
SELECT
  genome_id, canonical_accession, reference_namespace,
  MIN(reference_accession), MIN(organism_name), MIN(source),
  json_object('backfilledFrom', 'genomes')
FROM identities
GROUP BY genome_id, canonical_accession, reference_namespace;

WITH identities AS (
  SELECT
    release_id,
    accession,
    'ncbi_assembly:' || COALESCE(
      NULLIF(trim(genbank_assembly_accession), ''),
      NULLIF(trim(refseq_assembly_accession), ''),
      NULLIF(trim(reference_accession), ''),
      accession
    ) AS genome_id
  FROM genomes
)
INSERT INTO release_genomes (release_id, accession, genome_id)
SELECT release_id, accession, genome_id FROM identities;

INSERT OR IGNORE INTO genome_aliases (genome_id, namespace, alias, relation)
SELECT genome_id, 'rapptor_accession', accession, 'release_accession'
FROM release_genomes;

INSERT OR IGNORE INTO genome_aliases (genome_id, namespace, alias, relation)
SELECT rg.genome_id, 'ncbi_genbank', g.genbank_assembly_accession, 'ncbi_reciprocal'
FROM genomes g
JOIN release_genomes rg USING (release_id, accession)
WHERE NULLIF(trim(g.genbank_assembly_accession), '') IS NOT NULL;

INSERT OR IGNORE INTO genome_aliases (genome_id, namespace, alias, relation)
SELECT rg.genome_id, 'ncbi_refseq', g.refseq_assembly_accession, 'ncbi_reciprocal'
FROM genomes g
JOIN release_genomes rg USING (release_id, accession)
WHERE NULLIF(trim(g.refseq_assembly_accession), '') IS NOT NULL;

INSERT OR IGNORE INTO genome_aliases (genome_id, namespace, alias, relation)
SELECT rg.genome_id, g.reference_namespace, g.reference_accession, 'reference_accession'
FROM genomes g
JOIN release_genomes rg USING (release_id, accession)
WHERE NULLIF(trim(g.reference_accession), '') IS NOT NULL;

INSERT OR IGNORE INTO publications (
  publication_id, pmid, doi, title, authors_json, journal, publication_year, metadata_json
)
SELECT DISTINCT
  'pmid:' || json_extract(configuration_json, '$.pmid'),
  CAST(json_extract(configuration_json, '$.pmid') AS TEXT),
  json_extract(configuration_json, '$.publication.doi'),
  json_extract(configuration_json, '$.publication.title'),
  COALESCE(json_extract(configuration_json, '$.publication.authors'), '[]'),
  json_extract(configuration_json, '$.publication.journal'),
  CAST(json_extract(configuration_json, '$.year') AS INTEGER),
  COALESCE(json_extract(configuration_json, '$.publication'), '{}')
FROM feature_definitions
WHERE evidence_type = 'experimental'
  AND json_valid(configuration_json)
  AND json_extract(configuration_json, '$.pmid') IS NOT NULL;

INSERT OR IGNORE INTO experimental_studies (
  study_id, publication_id, source_id, source_version, study_year, provenance_json
)
SELECT
  definition_id,
  CASE
    WHEN json_extract(configuration_json, '$.pmid') IS NULL THEN NULL
    ELSE 'pmid:' || json_extract(configuration_json, '$.pmid')
  END,
  source_id,
  source_version,
  CAST(json_extract(configuration_json, '$.year') AS INTEGER),
  configuration_json
FROM feature_definitions
WHERE evidence_type = 'experimental' AND json_valid(configuration_json);

INSERT OR IGNORE INTO experimental_study_genomes (study_id, genome_id, source_accession)
SELECT DISTINCT fs.definition_id, rg.genome_id, fs.accession
FROM feature_sets fs
JOIN release_genomes rg USING (release_id, accession)
JOIN experimental_studies es ON es.study_id = fs.definition_id
WHERE fs.evidence_type = 'experimental';
