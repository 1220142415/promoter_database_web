---
status: diagnosed
trigger: "In SeqEdge's embedded JBrowse 2 browser, selecting an NCBI gene feature and clicking SHOW FEATURE SEQUENCE expands the genomic sequence, after which the site becomes unresponsive/freezes. Determine the root cause with evidence. Diagnose only: do not modify application source, dependencies, lockfiles, or config."
created: 2026-08-10T15:02:33+08:00
updated: 2026-08-10T15:30:10+08:00
---

## Current Focus

hypothesis: confirmed - installed @jbrowse/core 3.7.0 enters an infinite refetch/render loop because SequenceFeatureDetails constructs a new SimpleFeature on every render and useFeatureSequence keys its effect by that object's identity
test: completed with a one-variable React harness and exact release-data inspection
expecting: confirmed by 1,267 renders and 3,798 fetch calls in 100 ms versus 2 renders and 3 fetches with stable feature identity
next_action: return root-cause diagnosis; do not modify application source or dependencies

## Symptoms

expected: Clicking SHOW FEATURE SEQUENCE should display the selected gene/subfeature sequence and leave the UI responsive.
actual: Feature details opens normally for gene HMPREF1478_00003 at KE150450.1:3,704..5,231 (-), length 1,528. After SHOW FEATURE SEQUENCE, the genomic sequence is rendered and the site directly freezes/becomes unresponsive.
errors: No error message supplied. Screenshots show successful initial sequence rendering, not an explicit exception.
reproduction: Open genome browser around KE150450.1:1..10,000, click NCBI annotation HMPREF1478_00003, then click SHOW FEATURE SEQUENCE in the feature-details drawer.
started: Unknown whether this ever worked; current repository state dated 2026-08-10.

## Eliminated

- hypothesis: The freeze is the previous mixed JBrowse 3.x/4.x and BGZF dependency-tree failure.
  evidence: npm ls shows product-core, embedded-core, core, plugins, and plugin-linear-genome-view consistently resolved at 3.7.0. JBrowse's BGZF dependency is consistently 4.2.1.
  timestamp: 2026-08-10T15:30:10+08:00

- hypothesis: The 1,528 bp feature is too large, corrupt, or has pathological nested annotation data.
  evidence: The GFF has only gene, rRNA, and exon records with conventional short attributes. The exact FASTA slice is 1,528 valid A/C/G/T/N bases from a correctly indexed 1,289,359 bp contig.
  timestamp: 2026-08-10T15:30:10+08:00

- hypothesis: The createViewState onChange callback feeds every feature-detail mutation into parent state, recreating the view state in a render loop.
  evidence: src/app/genomes/[accession]/page.tsx renders PortalBrowserPanel without onRegionChange, so portal-jbrowse-viewer's callback returns at `!onRegionChange` and cannot update the parent in the reported genome-detail workflow.
  timestamp: 2026-08-10T15:11:40+08:00

## Evidence

- timestamp: 2026-08-10T15:05:10+08:00
  checked: .planning/debug/knowledge-base.md
  found: No project debug knowledge base exists.
  implication: There is no local known-pattern diagnosis to prioritize.

- timestamp: 2026-08-10T15:05:10+08:00
  checked: SeqEdge/package.json and prior investigation memory
  found: The prior runtime crash involved mixed @jbrowse/product-core 4.3.0 and @jbrowse/react-linear-genome-view 3.1.0, but the current manifest declares product-core 3.7.0 and react-linear-genome-view 3.1.0.
  implication: The historical mixed-major issue is a candidate only; the installed tree and current runtime must be checked directly.

- timestamp: 2026-08-10T15:08:20+08:00
  checked: npm ls @jbrowse/product-core @jbrowse/react-linear-genome-view @jbrowse/plugin-linear-genome-view @gmod/bgzf-filehandle --all
  found: All installed JBrowse product/core/plugins resolve to 3.7.0, with react-linear-genome-view 3.1.0 using embedded-core 3.7.0. JBrowse uses @gmod/bgzf-filehandle 4.2.1 consistently; only the app's independent @gmod/indexedfasta uses BGZF 5.0.2.
  implication: The prior mixed JBrowse-major/BGZF runtime crash is not present in the current dependency graph.

- timestamp: 2026-08-10T15:08:20+08:00
  checked: src/components/portal-jbrowse-viewer.tsx and its component test
  found: createViewState receives an onChange callback that reads the visible region and invokes the parent for every JBrowse model change; useMemo recreates the entire view state whenever assembly or onRegionChange identity changes. The test mocks JBrowse and verifies only that the callback exists, not its runtime behavior.
  implication: A model-change to parent-render feedback loop remains a concrete, testable integration hypothesis.

- timestamp: 2026-08-10T15:11:40+08:00
  checked: src/app/genomes/[accession]/page.tsx and src/components/portal-browser-panel.tsx
  found: The reported genome detail page passes only `assembly` to PortalBrowserPanel; it does not pass onRegionChange.
  implication: The viewer's onChange handler exits before visible-region work in this workflow, eliminating the parent-render feedback-loop hypothesis.

- timestamp: 2026-08-10T15:16:10+08:00
  checked: node_modules/@jbrowse/core/BaseFeatureWidget/SequenceFeatureDetails/SequenceFeatureDetails.js and node_modules/@jbrowse/core/util/useFeatureSequence.js
  found: SequenceFeatureDetails calls useFeatureSequence with `feature: new SimpleFeature(feature)` directly in render. useFeatureSequence memoizes a new key with `feature` in its dependency list and runs its fetch effect whenever that key changes. Successful fetch completion calls setSequence with a fresh object.
  implication: Each successful fetch forces a render, creates a new SimpleFeature identity and request key, and restarts three sequence fetches. This is a specific infinite refetch/render-loop mechanism inside installed @jbrowse/core 3.7.0.

- timestamp: 2026-08-10T15:16:10+08:00
  checked: node_modules/@jbrowse/core/BaseFeatureWidget/SequenceFeatureDetails/SequenceFeaturePanel.js and SequencePanel.js
  found: The button only sets local `shown` state; after sequence loading, the panel renders into a max-height 300 px scrolling container. No app-owned sequence formatting or unbounded layout implementation is involved.
  implication: The freeze occurs after mounting JBrowse's lazy sequence-detail path, consistent with the identified hook loop rather than the 1,528 bp sequence display itself.

- timestamp: 2026-08-10T15:28:40+08:00
  checked: Minimal React 19.2.4 harness executing installed @jbrowse/core 3.7.0 useFeatureSequence with its fetch function instrumented
  found: Reconstructing `new SimpleFeature(serialized)` on every render, as SequenceFeatureDetails does, caused 1,267 renders and 3,798 fetch calls in 100 ms plus 24 `Maximum update depth exceeded` warnings. The only-variable control using one stable SimpleFeature produced 2 renders and exactly 3 fetch calls (feature, upstream, downstream).
  implication: Feature object identity is causal, and the unbounded render/fetch loop directly explains the browser becoming unresponsive immediately after the sequence first appears.

- timestamp: 2026-08-10T15:28:40+08:00
  checked: .data/releases/2026-08-07/objects/GCA_000411415.1/ncbi-annotations.gff3.gz
  found: HMPREF1478_00003 has one ordinary gene (3704-5231, minus strand), one rRNA child, and one exon child. The inclusive span is 1,528 bp; attributes are short and conventional.
  implication: Neither a huge feature nor pathological GFF attribute/subfeature volume explains the freeze.

- timestamp: 2026-08-10T15:30:10+08:00
  checked: Exact FASTA slice KE150450.1:3704-5231 from reference.fa.gz
  found: The contig decompresses to its indexed length of 1,289,359 bp; the requested slice is exactly 1,528 bp and contains only valid nucleotide symbols.
  implication: Sequence retrieval input is valid and small; the loop is independent of biological sequence size/content.

## Resolution

root_cause: Installed @jbrowse/core 3.7.0 SequenceFeatureDetails creates `new SimpleFeature(feature)` on every render, while useFeatureSequence includes that feature object in the memoized request-key dependency list. Mounting the feature-sequence panel therefore makes every state update create a new key and restart the effect's three sequence fetches, causing an unbounded React render/fetch loop and UI starvation after the first sequence result appears.
fix: Not applied (diagnose-only mode). Fix direction is to use a stable SimpleFeature identity across renders or move useFeatureSequence dependencies to stable primitive coordinates; alternatively consume an upstream JBrowse release in which this loop is fixed, after confirming the change and compatibility.
verification: Causality reproduced with the installed hook. Fresh SimpleFeature identity produced 1,267 renders, 3,798 fetch calls, and 24 maximum-update-depth warnings in 100 ms; stable identity produced 2 renders and 3 expected fetches. Exact feature/reference data is valid and only 1,528 bp.
files_changed: []
