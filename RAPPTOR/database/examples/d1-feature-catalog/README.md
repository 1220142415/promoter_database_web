# RAPPTOR D1 feature catalog example

This example extracts the two genomes currently present in the public
Hugging Face pilot from
`src/generated/release-catalog.json` into the proposed four business tables and
two search-support tables.

Generate the seed file:

```bash
npm run data:d1:sample
```

The two SQL files can then be executed in order against an empty SQLite or D1
database:

1. `schema.sql`
2. `sample-data.sql`

The sample only creates one promoter feature-set row per genome. Individual
promoter coordinates remain in the indexed GFF3 files and are never inserted
into D1. Terminator and RNA rows can be added later using the same structure.

The historical catalog does not record the exact RAPPTOR model/version or the
NCBI annotation release, so `source_version` is deliberately set to
`unrecorded`. It must be replaced with real provenance in future releases.

Useful inspection query:

```sql
SELECT
  g.accession,
  g.organism_name,
  p.feature_count AS promoter_count,
  p.status AS promoter_status,
  p.data_path AS promoter_gff3
FROM genomes AS g
LEFT JOIN feature_sets AS p
  ON p.release_id = g.release_id
 AND p.accession = g.accession
 AND p.feature_type = 'promoter'
 AND p.is_default = 1
ORDER BY g.accession;
```
