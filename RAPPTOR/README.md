# RAPPTOR

RAPPTOR is a genome-first portal for the GTDB test release supplied on 2026-08-07. It provides a searchable catalog, accession-scoped JBrowse 2 views, and reproducible downloads without loading the full promoter collection into a database.

See [`docs/architecture.md`](docs/architecture.md) for directory ownership,
runtime request flows, and file-placement rules.

## Release

- 1,000 versioned GCA/GCF assemblies
- 23,405,141 RAPPTOR `promoter_peak` predictions with scores greater than 0.9
- GTDB taxonomy for all 1,000 assemblies
- 656 NCBI annotation files downloaded and 344 explicitly unavailable; 29 circular-origin annotations are normalized into origin-side segments for indexed browser tracks
- No experimental transcription start-site dataset

The source archive does not identify its GTDB release. The portal therefore reports the dataset version `2026-08-07` and does not claim a GTDB release number.

## User workflow

1. Open the genome catalog and search by accession, organism, or taxonomy.
2. Filter the catalog by phylum, genome source, or NCBI annotation availability.
3. Open one assembly to inspect its reference, predicted promoter, and optional NCBI annotation tracks.
4. Download the indexed files and genome metadata for that assembly.
5. Use the Data & methods page for provenance, evidence boundaries, formats, manifests, and checksums.

The homepage also contains a promoter-prediction interface. Its default
`demo` mode returns a fixed, explicitly labelled UI fixture and never sends raw
candidate or genome sequences to the server. Apply
`database/migrations/0007_prediction_demo.sql` before enabling the demo on a
Cloudflare deployment; only ticket hashes, checksums and job metadata are
stored. Set `RAPPTOR_PREDICTION_MODE=remote` only after configuring the remote
Docker API, server token and both Turnstile keys documented in
`.env.local.example`.

Predicted promoters and NCBI annotations are separate evidence classes. The portal does not infer promoter-gene assignments and does not label predicted peaks as experimental TSS.

## Requirements

- Node.js 20 or newer
- npm
- WSL Ubuntu on Windows, or a native Unix environment
- `samtools`, `bgzip`, `tabix`, `gzip`, and `tar`

On Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y samtools tabix
```

## Build the release

Place `gtdb_selected_data_20260807.tar.gz` one directory above this project, then run:

```bash
npm run data:build
npm run data:validate
```

On Windows, run the build in WSL so the native indexing tools are available:

```bash
cd /mnt/d/科研/promoter/datasetweb/RAPPTOR
node scripts/data/build-gtdb-release.mjs --tool-mode native --force
node scripts/data/validate-gtdb-release.mjs
```

To include the step-50 raw RAPPTOR scores, install the offline converter dependencies and pass the directory containing one Parquet file per release accession:

```bash
python3 -m pip install pyarrow pyBigWig
node scripts/data/build-gtdb-release.mjs --tool-mode native --score-root /path/to/prediction_scores_step_50 --force
```

Each Parquet file name must contain its versioned `GCA_...` or `GCF_...` accession. The canonical schema is `Sequence_ID`, `Start`, `End`, `Score`, and `Strand`; RAPPTOR `.sidecar.parquet` files with `Sequence_ID`, `Position`, `Score`, and `Strand` are also accepted, with `Position` interpreted as the 0-based 1 bp anchor start. Scores stay in `[0,1]`, and adjacent anchors on each contig and strand must be 50 bp apart. The builder writes `promoter-scores.plus.bw` and `promoter-scores.minus.bw`; it does not copy the Parquet input into the release. Without `--score-root` (and without an archive directory named `prediction_scores_step_50`), releases remain compatible and omit these optional assets.

Generated large files are written to `.data/releases/2026-08-07/` and ignored by Git. The small application catalog is copied to `src/generated/release-catalog.json`.

Each accession contains:

```text
reference.fa.gz
reference.fa.gz.fai
reference.fa.gz.gzi
predicted-promoters.gff3.gz
predicted-promoters.gff3.gz.tbi
promoter-scores.plus.bw          # when raw scores are supplied
promoter-scores.minus.bw         # when raw scores are supplied
ncbi-annotations.gff3.gz       # only when available
ncbi-annotations.gff3.gz.tbi   # only when available
metadata.json
```

The release root also contains `catalog.json`, `release.json`, `manifest.tsv`, and `checksums.sha256`.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app serves generated assets through a path-restricted local route with GET, HEAD, and byte-range support.

`npm start` runs the standalone server from the project directory. If the standalone bundle is copied elsewhere, mount the release directory and set `LOCAL_DATA_ROOT` plus `LOCAL_RELEASE_ROOT`, or configure the two object-storage URLs instead.

## Genome catalog API

The genome catalog is rendered with the first 25 rows on the server. Search, taxonomy/source filtering, annotation availability, sorting, and later pages use `GET /api/genomes`; the browser never downloads the full catalog.

Supported query parameters are `q`, `domain`, `phylum`, `class`, `order`, `family`, `genus`, `source`, `annotation`, `sort`, `direction`, `limit`, and `cursor`. `limit` must be 25, 50, or 100. Pagination cursors are opaque and tied to the selected sort field and direction. `annotation=unavailable` includes both missing and assembly-incompatible NCBI annotations.

Server code accesses the catalog through `GenomeCatalogRepository.search()` and `GenomeCatalogRepository.getByAccession()`. Local development reads and caches `src/generated/release-catalog.json`; production uses the `RAPPTOR_DB` D1 binding. Promoter counts and file references are joined from the default `feature_sets` row, while genomic intervals remain in indexed GFF3 files.

## Object storage

Upload the contents of `.data/releases/2026-08-07/objects/` to an object-storage prefix and set:

```env
NEXT_PUBLIC_STORAGE_BASE_URL=https://storage.example.org/rapptor/2026-08-07
NEXT_PUBLIC_RELEASE_ASSET_BASE_URL=https://storage.example.org/rapptor/2026-08-07
```

The storage origin must allow GET, HEAD, Range requests, and the deployed portal origin through CORS. Upload the release-level JSON, TSV, and checksum files to the release root.

### Hugging Face two-genome pilot

The phase-two pilot uses `GCA_000411415.1` (NCBI annotation available) and `GCA_000421325.1` (annotation unavailable). Prepare the upload directory without modifying the release:

```bash
npm run hf:prepare
```

Install the official Hub client, authenticate with a write-scoped token, and upload to a public Dataset repository:

```bash
python -m pip install --upgrade huggingface_hub
hf auth login
npm run hf:upload -- --repo <owner>/<repo>
```

The token must stay outside the repository. `HF_TOKEN` may be supplied through the shell instead of the saved Hugging Face login. The upload script creates the Dataset when necessary and writes only the prepared pilot under `releases/2026-08-07/`.

Verify every uploaded pilot file against the local manifest and checksum, including byte-range `206` responses and browser CORS on FASTA/GFF3 files:

```bash
npm run hf:verify -- --repo <owner>/<repo>
```

To validate a transparent mirror instead of the official endpoint, add `--endpoint https://hf-mirror.com`. A mirror is accepted only if the same Range, CORS, size, and SHA-256 checks pass.

After verification passes, copy the two URLs printed by the verifier to `.env.local` as `NEXT_PUBLIC_STORAGE_BASE_URL` and `NEXT_PUBLIC_RELEASE_ASSET_BASE_URL`, restart the portal, and test both JBrowse detail pages. This pilot intentionally uploads only two object directories; it is not a complete public release.

For a partial pilot, configure `HF_PILOT_STORAGE_BASE_URL` and `HF_PILOT_ACCESSIONS` instead. Only those accessions are routed through the path-restricted `/api/remote-data/<accession>/<file>` Range proxy; the remaining genomes continue to use local release data. This same-origin proxy is useful when an end-user browser cannot reach Hugging Face directly and never accepts arbitrary upstream URLs or unlisted files.

### Hugging Face complete 1,000-genome release

Phase three uploads the validated release directly from `.data/releases/2026-08-07/` in resumable accession batches. A rerun compares remote LFS SHA-256 or Git blob IDs and uploads only missing or different files. It also replaces the partial pilot markers after all batches succeed.

```bash
npm run hf:upload:release -- --repo <owner>/<repo>
npm run hf:verify:release -- --repo <owner>/<repo>
```

The verifier checks the complete remote inventory, sizes, every LFS SHA-256 or regular Git blob ID, and deterministic FASTA/GFF3 Range and CORS samples. After it passes, configure the complete same-origin proxy:

```env
NEXT_PUBLIC_STORAGE_BASE_URL=/api/remote-data
NEXT_PUBLIC_RELEASE_ASSET_BASE_URL=https://huggingface.co/datasets/<owner>/<repo>/resolve/main/releases/2026-08-07
HF_STORAGE_BASE_URL=https://huggingface.co/datasets/<owner>/<repo>/resolve/main/releases/2026-08-07/objects
```

In complete-release mode, `/api/remote-data` accepts only accessions present in the server catalog and the fixed RAPPTOR asset filenames. The pilot variables are no longer required.

## Validation

```bash
npm run lint
npm test
npm run test:data
npm run build
npm run test:e2e
npm run build:cf
```

Deploy the validated OpenNext build to Cloudflare Workers with:

```bash
npm run deploy:cf
```

For Workers Builds, use `npm run build:cf` as the build command and
`npx @opennextjs/cloudflare deploy` as the deploy command. Configure
`NEXT_PUBLIC_STORAGE_BASE_URL=/api/remote-data` and the active release URL as
`NEXT_PUBLIC_RELEASE_ASSET_BASE_URL` in the Cloudflare build environment.
The complete connection settings, first-build trigger, troubleshooting notes,
and cost controls are recorded in
[`docs/cloudflare-workers-builds.md`](docs/cloudflare-workers-builds.md).

The full data validator checks collection counts, accession identity, feature types, score and strand bounds, FASTA/GFF3 coordinate containment, BGZF and Tabix indexes, manifests, and SHA-256 digests.

### Standalone and Cloudflare builds from WSL

Run production and Cloudflare builds with Linux-installed dependencies inside WSL when working from Windows. Prefer a WSL-native checkout with its own `node_modules`; a dependency tree installed by Windows does not contain the Linux native Lightning CSS/SWC binaries.

```bash
npm ci
npm run build
npm run build:cf
```

If the checkout is shared under `/mnt/d`, running `npm ci` from WSL replaces its Windows-specific dependency tree. Re-run `npm ci` from Windows before using that same checkout with Windows Node.js again.

Next.js output tracing deliberately excludes `.data/**` from the local-only data routes. Next.js 15 does not reliably apply those globs to Windows backslash paths, so the postbuild step removes any traced `.data` directory only from inside the verified standalone output and then checks that none remain. The 1,000-genome release and future Packs therefore cannot enter the deploy artifact accidentally. This affects production packaging only: local development still reads `.data` normally. A standalone deployment that intentionally uses the local routes must mount the release separately and set `LOCAL_DATA_ROOT` and `LOCAL_RELEASE_ROOT`; the D1/Hugging Face production path does not need that mount.

## Packed single-repository releases and D1

The production layout is designed for more than 80,000 genomes without creating hundreds of thousands of Hugging Face files. Accessions use the first two hexadecimal characters of SHA-256 as a stable shard. Logical files remain visible in manifests as `objects/<shard>/<accession>/<file>`, while Hugging Face stores immutable aligned packs below each release.

```bash
npm run data:pack -- --source 2026-08-07 --source-release 2026-08-07 --release 2026-08-11
npm run data:pack:validate
npm run data:d1:legacy
npm run hf:plan -- --release 2026-08-11 --repo liurulong/bacterial-promoter-genomes
npm run hf:upload:browser -- --release 2026-08-11
```

For an 80,000-genome release, keep peak disk use near one shard/Pack by planning first. `--plan-only` hashes the source fragments and their zero-filled 4 KiB alignment gaps, writes `pack-plan.json` plus the release manifests/catalog/D1 import, but does not write any `.bin` Pack. Materialize one shard or one Pack immediately before upload:

```bash
npm run data:pack -- --source 2026-08-07 --source-release 2026-08-07 --release 2026-08-11 --plan-only
npm run data:pack:materialize -- --release 2026-08-11 --shard 00
# alternatively: --pack pack-00-000.bin
```

After the uploader has recorded `status: "complete"`, a valid `verifiedAt`, and immutable Hugging Face commit evidence (`commitUrl` and, when present, matching `commitIds`), reclaiming is hash-gated and dry-run by default. Inspect the proposed removal, then explicitly enable deletion. Only `.data/releases/<release>/packs/pack-*.bin` can be removed; source objects and logical paths are never deletion targets.

```bash
npm run hf:reclaim:pack -- --release 2026-08-11 --shard 00
npm run hf:reclaim:pack -- --release 2026-08-11 --shard 00 --delete
```

The browser uploader only connects to the Open Browser CDP port bound on localhost. It discovers `http://[::1]:9223/json/version` by default and also accepts an explicit loopback `--ws-endpoint`. The selected executable is `D:\open brower\open_browser\Chrome\Application\open_browser.exe`; use a dedicated profile outside the project and bind its debugging port to loopback only. File traffic therefore uses Open Browser's direct connection; the script never reads or exports cookies or tokens. Resume state is stored in `.data/upload-plans/`, and recreating the plan preserves completed batches whose local hashes and commit URL still match.

When a pending Pack batch references a planned `.bin` that is not present locally, the browser uploader automatically materializes that Pack from `pack-plan.json` before hashing and uploading it. Add `--reclaim-verified-packs` to delete the temporary Pack immediately after the complete Pack-only batch has been verified remotely and recorded in the resume state. Metadata batches and unverified Packs are not reclaimed.

```bash
npm run hf:upload:browser -- --release 2026-08-11 --reclaim-verified-packs
```

The CLI fallback consumes the same upload plan:

```bash
npm run hf:upload:packed:cli -- --release 2026-08-11 --dry-run
```

Full validation checks all 1,000 genomes and 7,312 logical fragments, fragment and Pack SHA-256 values, 4 KiB alignment, non-overlapping offsets, all 256 manifest/catalog shards, and D1 genome INSERT counts. `--quick` skips only rereading all large-file bytes.

D1 is bound as `RAPPTOR_DB`. Apply the migrations from `database/migrations` in order with `npx wrangler d1 migrations apply RAPPTOR_DB --remote`; `0002_feature_catalog.sql` preserves any catalog already created by the original `0001`. Then import the legacy rollback release from `.data/d1-imports/2026-08-07/` and the packed release from `.data/releases/2026-08-11/d1/`. Do not apply `activate.sql` until the Hugging Face release exists and its Pack hashes, D1 counts, API pagination, Range responses, preview deployment, and representative JBrowse pages all pass. Roll back with the legacy `activate-rollback.sql` without deleting either release or any Pack.

Production requires D1; local development defaults to the generated JSON catalog unless `RAPPTOR_CATALOG_BACKEND=d1` is explicitly set. The catalog API never exposes Pack offsets. Only the allowlisted `/api/remote-data/<accession>/<file>` proxy reads the active release mapping and rewrites a single logical Range. D1 import files contain at most 500 genomes each, and the complete 80,000-row catalog is never bundled into Next.js.

The homepage release metrics are a checked-in snapshot in `src/generated/release-summary.json`. This keeps homepage requests static and avoids a D1 read for counts that only change when a release is published. Update that snapshot as part of each release deployment, then deploy the Worker and switch the D1 active release together. Genome lists, filters, details, and biological asset routes remain dynamic and continue to use D1.

For the numeric Hugging Face upload layout, generate the accession-to-batch plan from the sorted metadata TSV. The command writes an auditable `asset-links.tsv`, a compact 81-batch `asset-layout.json`, and a guarded one-row D1 update. Planned batches stay `staged` until all files and JBrowse indexes have been uploaded and verified.

```bash
npm run hf:batch-plan -- --input gtdb_genome_metadata_r214.tsv --output hf-batch-asset-plan
```

## Usage analytics

Usage analytics are disabled by default and start only when `RAPPTOR_ANALYTICS=on` is set. The default country-level report shows where a deployment is used; city-level collection requires `RAPPTOR_ANALYTICS_PRECISION=city`. On Cloudflare, location comes from the edge (`request.cf`), so no third-party geolocation service is called. No address or user agent is stored: each request is reduced to coarse location fields and an unlinkable visitor token made from the address, user agent, and a random per-UTC-day salt. Each successful counted request or dashboard read removes salts older than today's and yesterday's; cleanup waits while the deployment is idle.

API traffic, genome Range requests, static assets, router prefetches, usage dashboards, and known crawlers are never counted. The write runs as a Cloudflare background task after the response is sent, so counting never delays a page. A view means a full page load; navigating inside the app with the Next.js router is an RSC fetch that is indistinguishable from the prefetches the router fires for every visible link, so those are left out rather than counted twice. Visitor counts are unaffected.

Apply the migration once, explicitly enable collection, then set the dashboard credentials:

```bash
npx wrangler d1 migrations apply RAPPTOR_DB --remote
npx wrangler secret put RAPPTOR_ANALYTICS
npx wrangler secret put RAPPTOR_ANALYTICS_USERNAME
npx wrangler secret put RAPPTOR_ANALYTICS_PASSWORD
```

Set the value of `RAPPTOR_ANALYTICS` to `on`. Dashboard credentials control access to reports independently; they do not enable collection.

`/admin/usage` then shows a world map, a country table, top cities, top pages, and a daily trend over 7 days, 30 days, 90 days, 12 months, or all time. `/api/admin/usage` returns the same report as JSON, or CSV with `?format=csv&dataset=countries|cities|paths|daily`. Both answer 404 until both credentials exist, and both use HTTP Basic authentication afterwards.

Set `RAPPTOR_USAGE_PUBLIC_PAGE=on` to expose the same aggregated read-only report at `/usage`. It contains no raw addresses and offers no CSV/JSON exports. Unset the variable or use any other value to return 404 again; collection remains controlled separately by `RAPPTOR_ANALYTICS`.

| Variable | Effect |
| --- | --- |
| `RAPPTOR_ANALYTICS=on` | Explicitly enables collection. Unset and all other values leave collection off; recorded days remain readable. |
| `RAPPTOR_ANALYTICS_USERNAME`, `RAPPTOR_ANALYTICS_PASSWORD` | Reveal and protect the dashboard. Unset means 404 for every admin path. |
| `RAPPTOR_USAGE_PUBLIC_PAGE=on` | Exposes the aggregated read-only `/usage` report. Unset or another value hides it with 404. |
| `RAPPTOR_ANALYTICS_PRECISION=city` | Opt in to city, region, and coordinates. The default is country only. |
| `RAPPTOR_ANALYTICS_RETENTION_DAYS` | Days of history to keep, 400 by default. Expired rows are removed on the next successful counted request or dashboard read. |
| `RAPPTOR_ANALYTICS_TRUST_PROXY_HEADERS=on` | Outside Cloudflare, trust IP and location headers from a controlled reverse proxy. Leave unset for direct or untrusted traffic. |

The map is a build artifact: `npm run analytics:map` regenerates `src/generated/world-map.json` from Natural Earth 1:110m geometry (public domain, through `world-atlas`). It is projected at build time and rendered on the server as inline SVG, so the dashboard ships no client-side mapping library and stays within the portal Content Security Policy.

Cloudflare-provided address and `request.cf` data are trusted automatically. Outside Cloudflare, forwarded IP and location headers are ignored unless `RAPPTOR_ANALYTICS_TRUST_PROXY_HEADERS=on`; only enable it when a controlled proxy overwrites those headers. Otherwise location is recorded as unknown. Daily visitor totals are approximate: the same address and user-agent combination counts once per UTC day, and the range total is the sum of those daily values. Cleanup is request-driven, so an idle deployment does not promise deletion at an exact wall-clock time.

## Coordinate contract

Release GFF3 files retain 1-based, closed coordinates. RAPPTOR peaks are point features with equal start and end positions. JBrowse displays user-facing 1-based locations. No BED or database coordinate conversion is performed by this release portal.
