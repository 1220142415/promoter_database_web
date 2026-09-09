# Reference cache integration, 2026-09-10

## Collected updates and merge decisions

| Source | Commit | Included changes |
| --- | --- | --- |
| Upstream main | `f187bd7` | Promoter display intervals, strand tooltips, prediction browser coordinates and cyanobacteria release/migration tooling |
| Docker cache branch | `3367626` | Protected cache query/import/status APIs, independent cache worker, preserved PNG import and warm prediction runtime |
| Local frontend | `706f380` | Exact-100-bp routing, scan-only FASTA, mutually exclusive context sources, `.1` catalog / `.2` upload examples and NCBI fallback |

Merge `c8517a1` includes both remote histories. Git reported two textual conflicts: reference explanation in the workbench and the corresponding example test. Resolution retains the HF `.1` example and explicitly labeled NCBI option. Automatic merging also left a semantic mismatch: the `.1` example used the old `.2` compressed-checksum field. The resolver now uses its exact `sourceSha256`; tests keep the versions separate. The colleague's stride input test correction is retained.

Docker originally accepted only precomputed PNG imports, so it could not implement the requested FASTA download workflow. With the user's confirmation, FASTA import is added to the same protected endpoint and queue; existing CGR generation and atomic cache publishing are reused. No model change is included.

## Final request contract

Exactly one 100 bp target uses `predict`. A longer input uses `genome_scan` and its sole input is FASTA (raw pasted DNA is wrapped in a FASTA record). Scan submissions do not carry `sequence`, `reference_accession` or `genome_context`.

For catalog/NCBI 100 bp requests, Worker claims a valid ticket, binds its exact accession, checks Docker cache, downloads and imports only on a miss, then submits the accession after readiness. CGR generation/storage remains in Docker. HF sources use the uploaded exact version; NCBI fallback does not silently replace accession versions. Cache preparation has a 40-second bound, import status polling uses 3-second intervals, and failed/expired attempts are not automatically resubmitted.

The detailed contract and required fields are in [prediction-ncbi-reference.md](prediction-ncbi-reference.md). D1 migrations 0015 and 0016 must precede the new Worker. Existing service secrets are reused and must never appear in Git or browser requests.

## Release checks

- Worker/frontend `npm run check`: ESLint and TypeScript passed; 108 test files / 875 tests passed. The live-runner billing correction also passed its 8 contract tests and scoped ESLint.
- Docker FASTA import and GCA submission compatibility: 127 passed, 1 skipped, 2 subtests passed. An isolated HTTP import completed `preparing` to `ready`; synthetic cache data was not retained in production.
- Docker deployed image: `rapptor-prediction-cpu:gca-fasta-20260910-1` (`6fe8f7e49020`), with rollback image `rapptor-prediction-cpu:fasta-import-20260910`. API, scan, predict and cache containers were updated with existing volumes/secrets retained; readiness succeeded and all four queues were empty. The deployed schema accepts GCA IDs. Legacy ticket `referenceSource.sha256` is not compared to the imported uncompressed FASTA hash on the cache-only submission path.
- GitHub upstream was fetched again on September 10 and remained `f187bd7`; no newly arrived remote changes were discarded.
- Final Linux bundle, database migration, deployment version and browser acceptance are recorded after release below. A deployment or unit-test pass alone is not an end-to-end acceptance result.

## Acceptance boundary

No bulk 90-genome/version cache warm-up is included in this release. This change connects cache lookup and on-demand import; it does not establish that every historical version is present at HF or cached on the server. No model or inference algorithm was changed.
