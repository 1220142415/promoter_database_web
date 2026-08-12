# SeqEdge

SeqEdge is a genome-first portal for the GTDB test release supplied on 2026-08-07. It provides a searchable catalog, accession-scoped JBrowse 2 views, and reproducible downloads without loading the full promoter collection into a database.

## Release

- 1,000 versioned GCA/GCF assemblies
- 23,405,141 RAPPtor `promoter_peak` predictions with scores greater than 0.9
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
cd /mnt/d/科研/promoter/datasetweb/SeqEdge
node scripts/build-gtdb-release.mjs --tool-mode native --force
node scripts/validate-gtdb-release.mjs
```

Generated large files are written to `.data/releases/2026-08-07/` and ignored by Git. The small application catalog is copied to `src/generated/release-catalog.json`.

Each accession contains:

```text
reference.fa.gz
reference.fa.gz.fai
reference.fa.gz.gzi
predicted-promoters.gff3.gz
predicted-promoters.gff3.gz.tbi
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

Server code accesses the catalog through `GenomeCatalogRepository.search()` and `GenomeCatalogRepository.getByAccession()`. Local development reads and caches `src/generated/release-catalog.json`; production uses the `SEQEDGE_DB` D1 binding. Promoter counts and file references are joined from the default `feature_sets` row, while genomic intervals remain in indexed GFF3 files.

## Object storage

Upload the contents of `.data/releases/2026-08-07/objects/` to an object-storage prefix and set:

```env
NEXT_PUBLIC_STORAGE_BASE_URL=https://storage.example.org/seqedge/2026-08-07
NEXT_PUBLIC_RELEASE_ASSET_BASE_URL=https://storage.example.org/seqedge/2026-08-07
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

In complete-release mode, `/api/remote-data` accepts only accessions present in the server catalog and the fixed SeqEdge asset filenames. The pilot variables are no longer required.

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

The full data validator checks collection counts, accession identity, feature types, score and strand bounds, FASTA/GFF3 coordinate containment, BGZF and Tabix indexes, manifests, and SHA-256 digests.

### Standalone and Cloudflare builds from WSL

Run production and Cloudflare builds with Linux-installed dependencies inside WSL when working from Windows. Prefer a WSL-native checkout with its own `node_modules`; a dependency tree installed by Windows does not contain the Linux native Lightning CSS/SWC binaries.

```bash
npm ci
npm run build
npm run build:cf
```

If the checkout is shared under `/mnt/d`, running `npm ci` from WSL replaces its Windows-specific dependency tree. Re-run `npm ci` from Windows before using that same checkout with Windows Node.js again.

Next.js output tracing deliberately excludes `.data/**` from the three local-only routes (`/api/local-data`, `/api/local-region`, and `/api/local-release`). The postbuild step fails if a standalone bundle still contains a `.data` directory, so the 1,000-genome release and future Packs cannot be copied into the deploy artifact accidentally. Use WSL for production builds: Next.js 15's trace-exclusion matcher does not reliably match Windows backslash paths, and the guard will reject that oversized Windows artifact. This affects production packaging only: local development still reads `.data` normally. A standalone deployment that intentionally uses the local routes must mount the release separately and set `LOCAL_DATA_ROOT` and `LOCAL_RELEASE_ROOT`; the D1/Hugging Face production path does not need that mount.

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

D1 is bound as `SEQEDGE_DB`. Apply `migrations/0001_seqedge_catalog.sql`, then import the legacy rollback release from `.data/d1-imports/2026-08-07/` and the packed release from `.data/releases/2026-08-11/d1/`. Keep both inactive until Pack hashes, D1 counts, API pagination, Range responses, preview deployment, and representative JBrowse pages pass; only then apply `activate.sql`. Roll back with the legacy `activate-rollback.sql` without deleting either release or any Pack.

Production requires D1; local development defaults to the generated JSON catalog unless `SEQEDGE_CATALOG_BACKEND=d1` is explicitly set. The catalog API never exposes Pack offsets. Only the allowlisted `/api/remote-data/<accession>/<file>` proxy reads the active release mapping and rewrites a single logical Range. D1 import files contain at most 500 genomes each, and the complete 80,000-row catalog is never bundled into Next.js.

## Coordinate contract

Release GFF3 files retain 1-based, closed coordinates. RAPPtor peaks are point features with equal start and end positions. JBrowse displays user-facing 1-based locations. No BED or database coordinate conversion is performed by this release portal.
