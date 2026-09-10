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

Exactly one 100 bp target uses `predict`. A longer input uses `genome_scan` and
its target is always FASTA (raw pasted DNA is wrapped in a FASTA record). A
complete target assembly can also supply its own CGR. A partial scan may carry
one independent complete-reference source: `reference_accession` or
`genome_context`. These fields condition the model only; they do not replace
the target FASTA or its coordinates.

For catalog/NCBI 100 bp requests, Worker claims a valid ticket, binds its exact accession, checks Docker cache, downloads and imports only on a miss, then submits the accession after readiness. CGR generation/storage remains in Docker. HF sources use the uploaded exact version; NCBI fallback does not silently replace accession versions. Cache preparation has a 40-second bound, import status polling uses 3-second intervals, and failed/expired attempts are not automatically resubmitted.

The detailed contract and required fields are in [prediction-ncbi-reference.md](prediction-ncbi-reference.md). D1 migrations 0015 and 0016 must precede the new Worker. Existing service secrets are reused and must never appear in Git or browser requests.

## Release checks

- Worker/frontend `npm run check`: ESLint and TypeScript passed; 108 test files / 875 tests passed. The live-runner billing correction also passed its 8 contract tests and scoped ESLint.
- Docker FASTA import and GCA submission compatibility: 127 passed, 1 skipped, 2 subtests passed. An isolated HTTP import completed `preparing` to `ready`; synthetic cache data was not retained in production.
- Docker deployed image: `rapptor-prediction-cpu:gca-fasta-20260910-1` (`6fe8f7e49020`), with rollback image `rapptor-prediction-cpu:fasta-import-20260910`. API, scan, predict and cache containers were updated with existing volumes/secrets retained; readiness succeeded and all four queues were empty. The deployed schema accepts GCA IDs. Legacy ticket `referenceSource.sha256` is not compared to the imported uncompressed FASTA hash on the cache-only submission path.
- GitHub upstream was fetched again on September 10 and remained `f187bd7`; no newly arrived remote changes were discarded.
- Integration commit `2818ce6693a0c98661ca3e14da80b625538279c0` was fast-forwarded into local `main` and pushed normally to `1220142415/promoter_database_web` (`origin/main`). Local and remote main matched after the push.
- Final Linux bundle, database migration, deployment version and browser acceptance are recorded after release below. A deployment or unit-test pass alone is not an end-to-end acceptance result.

## Build environment recovery

The WSL build environment stopped responding during dependency installation and returned `Wsl/Service/0x8007274c`. Only this task's install session was interrupted; the WSL instance was not restarted and no existing bundle was deployed. The fallback uses a new isolated directory on the 4090 Linux host, an explicit archive of the release commit, and a temporary Node 22.22.3 runtime. The system Node installation, running prediction containers and production volumes are not part of the web build. Deployment credentials are not included in the source archive.

## Production release evidence

- Linux release build of `2818ce6693a0c98661ca3e14da80b625538279c0`: ESLint, TypeScript, 108 test files / 875 tests, Next.js production compilation and OpenNext bundle generation all succeeded. After the host's older glibc rejected a build dependency, an isolated temporary container supplied a compatible userland; it mounted only the build directory and had no production network or volume access.
- Remote D1 migrations `0015` and `0016` applied successfully in order; a subsequent migration list reported no pending migrations.
- Cloudflare production version **119**, ID `f1df3a05-7a96-4d61-8329-f4d3bb79dec7`, receives **100%** of traffic. Its Wrangler annotation is `Git-2818ce6693a0c98661ca3e14da80b625538279c0-cache-first-FASTA-imports`. Deployment secrets were not changed.
- HTTP checks on `https://rapptor.duolalab.qzz.io`: `/`, `/genomes`, `/api/genomes`, `/api/predictions/capabilities` returned 200. `/login` followed its redirect to 200. `/api/prediction-auth` returned the expected 404 `AUTH_DISABLED` for IP mode.
- In-app browser opened the deployed `/predict` on the custom domain. Synthetic form-only fixtures confirmed: 100 bp shows the context selector; catalog/search and complete-FASTA panels are mutually exclusive; the `.2` NCBI example appears in the upload panel; 300 bp displays `Sequence scan` and hides the context selector. A screenshot was captured in the session. The synthetic input was cleared and no task was submitted.
- Non-blocking UI follow-ups observed: the introduction still mentions a catalog genome as a scan input, and hiding context leaves visible step numbers 1 and 3. These copy/numbering issues do not change the tested request routing.

## Acceptance boundary

No bulk 90-genome/version cache warm-up is included in this release. This change connects cache lookup and on-demand import; it does not establish that every historical version is present at HF or cached on the server. No model or inference algorithm was changed.

Real production submission, a cold reference download/import through Cloudflare, and its CPU/memory measurement remain unverified. Form checks and HTTP smoke checks are not a completed prediction or cold-cache end-to-end acceptance. The first in-app visit to the workers.dev hostname timed out; the deployed custom domain subsequently loaded successfully in a fresh in-app tab.
