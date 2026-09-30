# RAPPTOR

RAPPTOR provides a searchable genome catalog, JBrowse 2 views, downloads, and queued promoter prediction.
Production: [rapptor.xulab.science](https://rapptor.xulab.science).

The web app runs on Cloudflare Workers with D1 metadata and Hugging Face assets.
Prediction runs in a separate Docker service. Better Auth and D1 handle email login;
Resend delivers verification codes and task notifications.

中文维护入口：[README.zh-CN.md](README.zh-CN.md)。

## Local development

Use Node.js 22.18+ and npm. From `RAPPTOR/`:

```bash
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). The generated JSON catalog supports
local browsing; genome tracks additionally need local release files or configured
remote storage. Copy `.env.local.example` to `.env.local` for overrides.
Local prediction setup is a separate step described below.

## Maintainer guides

| Task | Guide |
| --- | --- |
| Understand components and code ownership | [Architecture](docs/architecture.md) |
| Deploy the web app, configure secrets, troubleshoot builds | [Deployment](docs/cloudflare-workers-builds.md) |
| Integrate catalog and prediction APIs | [API guide](docs/prediction-service.md) |
| Integrate OTP, sessions, and task emails | [Email guide](docs/email-system-integration.zh-CN.md) |
| Build, upload, and activate datasets | [Data releases](docs/data-release.md) |
| Configure analytics and reports | [Usage analytics](docs/usage-analytics.md) |
| Run local predictions without email login | [Local prediction setup](docs/prediction-local-test.md) |
| Maintain the Docker inference service | [Service README](services/prediction/README.md) |
| Inspect past designs and deployment evidence | [Archive](docs/archive/README.md) |

## Development checks

```bash
npm run check
npm run build
```

`npm run check` runs ESLint, TypeScript, and Vitest. Cloudflare deployment commands
and required build variables are in the deployment guide. Live inference is an
explicit operation described in [live acceptance](docs/prediction-live-acceptance.md).

## Data and scientific interpretation

The initial `2026-08-07` prediction release contains 1,000 versioned assemblies and
23,405,141 `promoter_peak` records above score 0.9. Its source archive does not name
a GTDB release. These counts describe that release, not the complete current catalog.
Experimental TSS observations use an independent release and appear on the unified
genome page when enabled. Predictions, NCBI annotations, and experimental evidence
remain distinct. Dataset production and coordinate conventions are in the data guide.
