# RAPPTOR architecture

RAPPTOR is a Next.js application deployed to Cloudflare Workers. Runtime code
lives under `src/`; offline dataset preparation and deployment tooling live
outside it.

## Directory ownership

```text
.github/         GitHub dependency and workflow configuration
config/          Tool-specific configuration inputs
database/        Cloudflare D1 migrations and standalone database examples
docs/            Architecture, deployment, and feature design records
patches/         patch-package changes for third-party dependencies
public/          Static files copied directly into the web build
scripts/         Offline and deployment commands, grouped by operational domain
src/
├── app/          Next.js pages, layouts, middleware-facing routes, and API endpoints
├── components/   UI shared by more than one feature
├── features/     Complete business features: UI, logic, persistence, and local types
├── generated/    Build-generated release snapshots; do not edit by hand
└── types/        Contracts shared by multiple features
tests/            Unit, component, API, and Playwright browser tests
```

Build outputs and installed dependencies (`.next`, `.open-next`, `.wrangler`,
`node_modules`) are local working directories and are not repository features.

`src/app` follows Next.js App Router conventions. A `page.tsx` owns a URL,
`route.ts` owns an HTTP endpoint, and a directory such as `[accession]` is a
dynamic URL segment. Route files should parse requests and delegate work; they
should not contain database or rendering implementations.

## Feature boundaries

New feature-specific code belongs in `src/features/<feature>`. Keep files at
the feature root until a real grouping exists; add `components/` or another
subdirectory only when it contains multiple files.

The current feature boundaries are:

```text
src/features/usage/
├── analytics.ts              request filtering, IP/geo normalization, privacy helpers
├── retention.ts              daily D1 retention cleanup used by Cloudflare Cron
├── store.ts                  Cloudflare runtime access and D1 reads/writes
├── types.ts                  usage collection and report contracts
└── components/
    ├── usage-dashboard.tsx
    ├── usage-trend.tsx
    └── usage-world-map.tsx
```

```text
src/features/genomes/
├── repository.ts             repository contract, JSON/D1 selection, D1 queries
├── json-catalog.ts           generated JSON fallback reader
├── search-query.ts           URL search validation and defaults
├── types.ts                  catalog rows, filters, facets, and result contracts
└── components/
    ├── genome-explorer.tsx
    └── release-state.tsx
```

```text
src/features/genome-browser/
├── components/                embedded browser panels, status, and download UI
├── plugins/                   RAPPTOR JBrowse renderers and plugins
├── jbrowse-share.ts           share-state creation and parsing
├── local-region-export.ts     server-side sequence/annotation export
├── on-demand-genome-assets.ts browser-side remote asset loading
└── track-download.ts          download names, regions, and metadata
```

```text
src/features/storage/
├── hf-batch-assets.ts         Hugging Face asset URL planning
└── storage-layout.ts          packed-release path and offset rules
```

Operational scripts are grouped separately from runtime features:

```text
scripts/
├── cloudflare/    Cloudflare checks and standalone build preparation
├── data/          release build, conversion, packing, and validation
├── database/      D1 import and sample generation
├── huggingface/   upload planning, upload, verification, and reclamation
├── shared/        code shared by more than one script group
└── types.d.ts     TypeScript declarations for scripts imported by tests
```

The proposed prediction service will live in `services/prediction/` when its
Docker API and worker code exist. Its current design remains in
[`prediction-service.md`](prediction-service.md); no empty service scaffold is
kept in Git.

## Runtime flows

### Genome catalog

```text
/genomes or /api/genomes
  -> genome search/query logic
  -> catalog repository
  -> Cloudflare D1 in deployment, generated JSON in local fallback mode
```

### Genome browser assets

```text
/genomes/[accession]
  -> JBrowse components and plugins
  -> local-data or remote-data API route
  -> local release files or Hugging Face storage
```

### Usage and IP recognition

```text
request
  -> src/middleware.ts before page/API routing
  -> src/features/usage/analytics.ts validates and minimizes IP/geo data
  -> src/features/usage/store.ts schedules aggregate D1 writes
  -> /usage or /admin/usage reads the aggregate report

daily Cloudflare Cron
  -> config/cloudflare-worker.mjs
  -> src/features/usage/retention.ts removes expired aggregate rows and salts
```

Collection is controlled by `RAPPTOR_ANALYTICS`; the public report is
independently controlled by `RAPPTOR_USAGE_PUBLIC_PAGE`. These compatibility
environment names, the `RAPPTOR_DB` D1 binding, existing worker/database names,
and internal JBrowse identifiers must not be renamed during source cleanup.

### Promoter prediction service (proposed)

```text
browser -> Cloudflare one-time ticket and limits -> Docker prediction API
        -> Redis/RQ queue -> CPU/GPU model worker -> R2 result
        -> D1 permanent job metadata
```

The implementation boundary, security rules, API contract, and delivery
estimate are recorded in [prediction-service.md](prediction-service.md).

## Placement checklist

- URL or HTTP endpoint: `src/app`
- Code used by one business feature: `src/features/<feature>`
- UI genuinely shared by multiple features: `src/components`
- Contract genuinely shared by multiple features: `src/types`
- Generated release snapshot: `src/generated`
- Offline/import/upload command: the matching `scripts/<domain>` directory
- Independent Docker runtime: `services/<service>` once implementation exists
- Schema change: a new numbered file in `database/migrations`

Avoid adding generic `utils`, `services`, or `helpers` directories. Name a file
after the domain operation it owns and move it only when more than one feature
actually shares it.
