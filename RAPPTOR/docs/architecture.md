# RAPPTOR architecture

RAPPTOR is a Next.js application deployed to Cloudflare Workers. Runtime code
lives under `src/`; offline dataset preparation and deployment tooling live
outside it.

## Directory ownership

```text
src/
├── app/          Next.js pages, layouts, middleware-facing routes, and API endpoints
├── components/   UI shared by more than one feature
├── features/     Complete business features: UI, logic, persistence, and local types
├── generated/    Build-generated release snapshots; do not edit by hand
├── jbrowse/      JBrowse-specific code awaiting migration into a feature
├── lib/          Cross-feature code and code awaiting feature migration
└── types/        Contracts shared by multiple features

scripts/          Offline data build, validation, packing, and upload commands
database/         Cloudflare D1 migrations and standalone database examples
tests/            Unit, component, API, and Playwright browser tests
config/           Tool-specific configuration inputs
patches/          patch-package changes for third-party dependencies
```

`src/app` follows Next.js App Router conventions. A `page.tsx` owns a URL,
`route.ts` owns an HTTP endpoint, and a directory such as `[accession]` is a
dynamic URL segment. Route files should parse requests and delegate work; they
should not contain database or rendering implementations.

## Feature boundaries

New feature-specific code belongs in `src/features/<feature>`. Keep files at
the feature root until a real grouping exists; add `components/` or another
subdirectory only when it contains multiple files.

The migrated feature boundaries are:

```text
src/features/usage/
├── analytics.ts              request filtering, IP/geo normalization, privacy helpers
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

The next useful boundaries are `jbrowse` and `storage`. Existing files remain
where they are until each feature is migrated as a tested unit.

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
```

Collection is controlled by `RAPPTOR_ANALYTICS`; the public report is
independently controlled by `RAPPTOR_USAGE_PUBLIC_PAGE`. These compatibility
environment names, the `RAPPTOR_DB` D1 binding, existing worker/database names,
and internal JBrowse identifiers must not be renamed during source cleanup.

## Placement checklist

- URL or HTTP endpoint: `src/app`
- Code used by one business feature: `src/features/<feature>`
- UI genuinely shared by multiple features: `src/components`
- Contract genuinely shared by multiple features: `src/types`
- Generated release snapshot: `src/generated`
- Offline/import/upload command: `scripts`
- Schema change: a new numbered file in `database/migrations`

Avoid adding generic `utils`, `services`, or `helpers` directories. Name a file
after the domain operation it owns and move it only when more than one feature
actually shares it.
