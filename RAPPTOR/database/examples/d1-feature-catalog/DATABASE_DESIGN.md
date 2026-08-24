# RAPPTOR genome resource database design

RAPPTOR uses D1 as a searchable catalog. Genome sequences and feature coordinates
remain in indexed object files; they are not copied into D1.

## Nine-table target model

| # | Table | Purpose | Current phase |
|---|---|---|---|
| 1 | `releases` | Dataset version, storage location and publication state | Implemented |
| 2 | `portal_state` | Single pointer to the active, verified release | Implemented |
| 3 | `genomes` | One row per genome and release | Implemented |
| 4 | `feature_definitions` | Release-level prediction/annotation method definitions | Implemented |
| 5 | `feature_sets` | Per-genome promoter, annotation and future TSS summaries | Implemented |
| 6 | `genome_search_terms` | Indexed tokens used by the search box | Implemented |
| 7 | `facet_options` | Precomputed taxonomy/source filter options | Implemented |
| 8 | `genome_assets` | One normalized row per FASTA/GFF/index object | Deferred |
| 9 | `annotation_feature_counts` | Queryable annotation subtype counts | Deferred |

The initial full GTDB migration deliberately implements seven tables. Asset
paths and checksums live in `genomes.reference_storage_json` and
`feature_sets` until object paths are populated. Annotation subtype counts live
in `feature_sets.detail_counts_json`. Tables 8 and 9 should be introduced only
when the product needs asset-level administration or subtype filtering.

## Relationships

```text
releases
  +-- genomes
  |     +-- feature_sets
  |     +-- genome_search_terms
  +-- feature_definitions
  |     +-- feature_sets
  +-- facet_options

portal_state --(active_release_id)--> releases
```

## Release lifecycle

1. Insert a release with `publication_status = 'staged'`.
2. Import genomes, definitions, feature summaries, search terms and facets.
3. Verify row counts, aggregate feature counts, checksums and representative queries.
4. Change the release to `ready` and atomically update `portal_state` when the
   metadata catalog is publishable. Feature rows can remain `staged` while
   their public objects are being uploaded.
5. Populate and verify public FASTA/GFF/index paths, then change the matching
   feature rows to `ready`. The detail page enables JBrowse only when the
   reference and promoter resources are ready.

The active release is never changed during bulk import. This prevents a partial
catalog from becoming visible. A verified metadata-only release is supported:
the catalog and detail metadata remain available while resource controls are
withheld.

## GTDB R214 mapping

- Stable genome identity, taxonomy and quality columns map to `genomes`.
- RAPPTOR method, model, threshold and generation time map once to
  `feature_definitions`.
- Per-genome promoter count/checksum maps to a promoter `feature_sets` row.
- Annotation status, total, subtype JSON, provenance and checksum map to an
  annotation `feature_sets` row.
- Experimental TSS will use another feature definition and feature-set row;
  `hasExperimentalTss` is derived from status and count.
- Large coordinate records remain in bgzip/Tabix files outside D1.

## Search and facets

`genome_search_terms` contains normalized accession, Tax ID, organism, strain,
species and assembly-name tokens. Prefix lookups use the existing
`genome_search_token` index.

`facet_options` stores unique taxonomy/source paths plus `genome_count`. It
avoids repeated `SELECT DISTINCT` scans over all genomes when users change a
filter. Taxonomy facets are returned progressively: domain first, then only the
next rank beneath the selected parent path. This avoids returning and rendering
the entire 25,000-plus option hierarchy on every catalog request.

## D1 request budget

The public query path is deliberately bounded:

| Operation | D1 statements | Notes |
|---|---:|---|
| Homepage, precomputed release | 0-1 | Counts and top phyla come from `feature_summary_json` |
| First catalog page | 1-3 | Active release and facets use short isolate-local caches |
| Filtered catalog page | 1-3 | Exact filtered count is included in the page statement |
| Unfiltered later page | 2-4 | Includes cursor validation; total comes from `releases.total_genomes` |
| Genome detail | 1-2 | Active release plus one genome/feature lookup |

The API response is edge-cacheable for five minutes. Unfiltered requests do not
run `COUNT(*)`; the verified release total is reused. List queries select only
the columns rendered by the table and do not parse or validate asset JSON.
The active release is cached for 30 seconds and a taxonomy facet path for five
minutes within a warm Worker isolate; these are performance caches, not the
source of truth.
Exact filtered totals are retained for pagination, so text or combined filters
still scan their matching set once. Replacing exact totals with `hasNext` would
save more rows but would change the current pagination contract.

## Deferred tables

`genome_assets` becomes useful once all FASTA, FAI, GZI, GFF and TBI paths and
checksums are populated. `annotation_feature_counts` becomes useful when CDS,
tRNA, rRNA or other subtype counts need filtering/sorting. Until then their JSON
representations are smaller and cheaper to import.
