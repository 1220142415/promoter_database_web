# Cloudflare Workers Builds

This document records the production deployment path for SeqEdge. The build is
performed by Cloudflare Workers Builds on Linux; local Windows OpenNext builds
are for development only because the OpenNext bundler is not fully compatible
with Windows.

## Current Configuration

| Setting | Value |
| --- | --- |
| Cloudflare Worker | `seqedge` |
| Git account | `duolaJohn` |
| Repository | `duolaJohn/promoter_database_web` |
| Production branch | `feature/genome-resource-db-promoter-v1` |
| Root directory | `/SeqEdge` |
| Build command | `npm run build:cf` |
| Deploy command | `npx @opennextjs/cloudflare deploy` |
| Non-production builds | Disabled to avoid unnecessary build usage |
| Build cache | Enabled |
| D1 binding | `SEQEDGE_DB` |
| D1 database ID | `13173011-d2b9-4763-b379-ecc1562ef497` |

The D1 database ID is part of `wrangler.toml` and must not be replaced when
editing the Cloudflare dashboard configuration.

## Build Variables

These are public build-time values, not secrets:

```text
NEXT_PUBLIC_STORAGE_BASE_URL=/api/remote-data
NEXT_PUBLIC_RELEASE_ASSET_BASE_URL=https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes/resolve/main
```

Do not commit an API token, a Hugging Face write token, or any other secret.
The dashboard creates and stores the Workers Builds token; its value must never
be copied into the repository or pasted into build logs.

## Normal Workflow

1. Run the local checks that do not require a Cloudflare bundle:

   ```bash
   npm test
   npx tsc --noEmit
   npm run lint
   ```

2. If the commit adds a numbered D1 migration, apply it before deploying the
   Worker. Wrangler records applied migrations and skips them on later runs:

   ```bash
   npx wrangler d1 migrations apply SEQEDGE_DB --remote
   ```

   Migration `0004_taxonomy_search.sql` adds the value index used by the
   current catalog taxonomy search. The query can still run if only the older
   schema is present, but D1 may scan the facet table; apply `0004` before
   production traffic so the bounded search path stays inexpensive.

3. Push a commit to `feature/genome-resource-db-promoter-v1`.
4. Open the Worker Deployments/Builds page and wait for the Linux build.
5. Inspect the build log. The expected sequence is `npm run build:cf`, then
   `npx @opennextjs/cloudflare deploy`.
6. Smoke-test `/`, `/genomes`, a genome detail route, `/api/genomes`, and one
   remote-data route through the configured proxy if Hugging Face is not
   directly reachable.

Connecting Workers Builds does not necessarily build the already-existing
commit. Push a new commit after the connection, or use the dashboard's rebuild
action when available.

## Browser Asset Cache Versioning

Unindexed per-genome FASTA and GFF3 source files are stored in the browser's
Cache Storage. The cache key contains the release, accession, asset kind, and
the asset SHA-256 when metadata provides one. Re-importing metadata with a new
checksum therefore creates a new cache entry automatically; the user does not
need to clear the browser cache after a file is replaced.

The current GTDB metadata has promoter and NCBI annotation SHA-256 values, but
does not yet provide a reference FASTA SHA-256. Reference files consequently
fall back to a release-and-URL-based key until that checksum is added. Changing
the release ID or asset URL still invalidates the reference cache.

## Troubleshooting

### `NEXT_PUBLIC_STORAGE_BASE_URL is required`

The build variables are missing from the Cloudflare **Build** configuration.
Add both variables above. Runtime Worker variables are a separate section and
do not satisfy this check.

### `ENOENT ... open-next.config.edge.mjs` on Windows

This is the known OpenNext Windows bundling failure. `next build` can succeed
before OpenNext fails while copying its generated edge configuration. Do not
debug this as a D1 or authentication problem. Use Workers Builds (Linux), WSL,
or another Linux CI runner. Do not add a generated `.open-next` file to Git.

### Build cannot find `package.json`

The repository contains the Next.js app below `SeqEdge/`. Set the Workers
Builds root directory to `/SeqEdge`; leaving it as `/` runs the commands from
the repository root and fails before the application build starts.

### The build uses `main`

Select the production branch from the dashboard combobox. Typing a branch name
without selecting the option can leave the hidden value as `main`.

### Hugging Face assets return 404

The catalog can contain planned links before every batch is uploaded. A 404 for
an asset that is not uploaded yet is expected; the homepage, catalog API, and
genome metadata must still return successfully. Verify the release base URL and
the accession batch mapping before changing D1 data.

## Cost and Safety Notes

- Keep non-production builds disabled unless a preview is needed.
- Keep build cache enabled to avoid repeating dependency installation work.
- Do not run bulk D1 imports or release rebuilds from a web request.
- Keep large FASTA/GFF3 downloads on Hugging Face; the Worker should only proxy
  allowlisted requests and issue one upstream Range request.
- Never change the D1 `database_id` or delete the existing database as part of
  a deployment retry.
