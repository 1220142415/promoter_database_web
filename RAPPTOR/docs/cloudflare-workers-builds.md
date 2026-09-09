# Cloudflare Workers Builds

This document records the production deployment path for RAPPTOR. Production
is deployed with Wrangler from a Linux build. A Cloudflare Workers Builds
connection may also be used, but its repository settings must be verified in
the dashboard before relying on an automatic deployment. The locked Wrangler
toolchain requires Node.js 22 or newer.

## Current Configuration

| Setting | Value |
| --- | --- |
| Cloudflare Worker | `rapptor` |
| Git account | `1220142415` |
| Repository | `1220142415/promoter_database_web` |
| Production branch | `main` |
| Root directory | `/RAPPTOR` |
| Build command | `npm run build:cf` |
| Deploy command | `npx @opennextjs/cloudflare deploy` |
| Non-production builds | Disabled to avoid unnecessary build usage |
| Build cache | Enabled |
| D1 binding | `RAPPTOR_DB` |
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
   npm run check
   ```

2. If the commit adds numbered D1 migrations, list and apply all pending
   migrations in order before deploying the Worker. Wrangler records applied
   migrations and skips them on later runs:

   ```bash
   npx wrangler d1 migrations list RAPPTOR_DB --remote
   npx wrangler d1 migrations apply RAPPTOR_DB --remote
   ```

   The prediction reference deployment requires
   `0015_prediction_reference_download.sql` followed by
   `0016_prediction_reference_binding.sql`.

3. Push the reviewed commit or merge its PR into `main`.
4. Deploy from Linux with `npm run deploy:cf`. If Workers Builds is connected,
   first verify the repository, branch, root directory, and commands above in
   the dashboard, then use its retry action or push a new commit to trigger it.
5. Inspect the build and deployment log. The expected sequence is
   `npm run build:cf`, then `npx @opennextjs/cloudflare deploy`.
6. Smoke-test `/`, `/genomes`, a genome detail route, `/api/genomes`, and one
   remote-data route through the configured proxy if Hugging Face is not
   directly reachable.

Connecting Workers Builds does not necessarily build the already-existing
commit. Push a new commit after the connection, or use the dashboard's rebuild
action when available.

## Windows Git Push Troubleshooting

The workstation may have environment overrides intended for an isolated test
runner. In particular, `GIT_SSH_COMMAND=cmd /c exit 1` deliberately disables
SSH, and the bundled MSYS2 SSH can fail with `couldn't create signal pipe`.
The repository and GitHub account are healthy when the following check returns
the `Hi duolaJohn!` authentication message:

```powershell
Remove-Item Env:GIT_SSH_COMMAND -ErrorAction SilentlyContinue
$env:GIT_SSH = 'C:\Windows\System32\OpenSSH\ssh.exe'
ssh -o BatchMode=yes -T git@github.com
git push fork feature/genome-resource-db-promoter-v1
```

If GitHub is only reachable through the local proxy, set `HTTP_PROXY` and
`HTTPS_PROXY` to `http://127.0.0.1:7997` for that PowerShell process. Do not
put a password, personal access token, or proxy credentials in a remote URL or
in repository files. The HTTPS credential helper is not required when the
system OpenSSH key is already authenticated.

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

This is a known OpenNext Windows bundling failure. Use Node.js 22 or newer in
WSL, Workers Builds, or another Linux CI runner. Do not downgrade to Node.js 20
or add a generated `.open-next` file to Git.

### Build cannot find `package.json`

The repository contains the Next.js app below `RAPPTOR/`. Set the Workers
Builds root directory to `/RAPPTOR`; leaving it as `/` runs the commands from
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
