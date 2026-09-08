# Automatic peak calling at stride 1

User confirmed automatic calling with sigma 1, minimum distance 10 bp, and
smoothed model score strictly greater than 0.9.

## Implementation

- Reused the partner's deployed peak implementation (9502ceb snapshot), matching
  the existing `call_peaks.py` order: sort each contig/strand by reference
  coordinate, Gaussian smoothing in reflect mode, distance selection, then cutoff.
- Dense genome scans add GFF3 automatically in API validation and the worker;
  non-dense scans keep raw score outputs. Peak cutoff is independent of sparse
  window export filtering. BigWig/Parquet remain raw and unfiltered.
- Local form requests the appropriate output formats, explains automatic peak
  calling, and prevents unsupported non-dense GFF3 requests to the newer service.
- Result page uses peak GFF3, Called peaks, and an unindexed JBrowse peak track.
  The existing protected downloads, both-strand BigWig ZIP, and old task display
  remain available. No new model inference is run on old jobs.
- Added explicit reference-coordinate metadata and compatibility for legacy
  strand-oriented window starts and the first partner smoothed-peaks schema.
- Kept the previous SpawnWorker fix and scan progress implementation. Preserved
  the partner's short-sequence source behavior; no short worker rollout occurred.

## Verification and deployment

- The user explicitly authorized testing on `4090-login (syl@10.160.16.11)` and
  updating the genome-scan worker after successful validation.
- 29 server tests passed: 14 peak/progress/artifact tests, 14 local API tests,
  and 1 real SpawnWorker regression with an isolated Redis and model preload.
  The earlier API/schema mixture in the test image was resolved by testing the
  complete local API separately from the deployed partner API contract.
- The scan worker was updated at **2026-09-08 15:26:37 Asia/Shanghai** to
  `rapptor-prediction-cpu:automatic-peaks-spawn-20260908`, image ID
  `sha256:8f4af2a008ba695d89f736a99f862c27862822073c3af28660d83e36bfa5735a`.
- Retained the partner's queue-specific heartbeat and worker maintenance switch,
  and applied SpawnWorker to avoid the previously reproduced CPU/CGR deadlock.
  The original runtime configuration, resources, network, and data volume were
  checked and preserved. API and short-sequence container identities were verified
  unchanged. The service is ready and the scan queue is idle after acceptance.
- Rollback container: `rapptor-prediction-worker-before-automatic-peaks-20260908`.
  The old container is stopped with restart disabled; its configuration backup
  remains private on the server. No website deployment or Git push was performed.

## Real acceptance result

Task: `52f3831f6e734c009697c4e57913fed5`.

- Two 4,000 bp excerpts from the pinned K-12 reference `NC_000913.3`, positions
  1–4,000 and 100,001–104,000. These are labelled as excerpts; the separate CGR
  context is the complete, checksum-verified 4,641,652 bp reference genome.
- Stride 1, both strands: **15,604 scored windows, 48 called peaks**. The request
  asked for BigWig/Parquet only, confirming automatic peak generation by the worker.
- Per-contig, per-strand peak counts: first excerpt **13 + / 8 −**, second excerpt
  **16 + / 11 −**. Independent SciPy smoothing/peak calling from all raw Parquet
  scores reproduced every peak coordinate and smoothed score (within GFF precision).
- All BigWig values match the raw Parquet scores. Artifact bytes and SHA-256 hashes
  match the manifest. The 125 TSV rows match the source smoothed-window GFF3 without
  extra filtering, with reference-oriented coordinates on both strands.
- Cookie-authenticated downloads and both BigWig Range requests succeeded;
  unauthenticated peak download was rejected. Both ZIP members match the original
  BigWig files exactly.
- The local result page visibly renders `RAPPtor predicted peaks` and both strand
  marker colors alongside raw score tracks. Its count is 48; 21 markers are visible
  on the first excerpt. Peak GFF3 and score-track ZIP download links are present.
- The development web ticket endpoint returned HTTP 429 before any task submission.
  The one acceptance task was submitted using the authorized server administration
  channel, with the normal input validation, private task token, and retention.
  The webpage quota settings were not changed. Web ticket issuance was therefore
  not part of the completed end-to-end acceptance path.

## Local checks and records

106 frontend tests passed for the original peak integration. A further focused
16-test run covered default peak-track visibility and the distinction between
missing peak output and a legitimate zero-peak result. TypeScript, scoped ESLint,
and the production build passed; the last small status-copy change was checked
with the focused tests, TypeScript, ESLint, and the real browser.

Ignored records are in `.codex-runtime/peak-calling-20260908/`: deployment result,
server rollout script, isolated test setup, and `live/report.json` with independent
parity evidence and verified artifact files. Access tokens are kept only in ignored
private access records and are not included in this document.

## Local score-track smoothing follow-up

Live tasks with a recorded 1 bp stride now display Gaussian-smoothed model scores
(sigma 1, reflect, truncate 4), matching peak calling. The browser adapter reads
full-resolution BigWig data in bounded chunks with a 4 bp halo, smooths each
contiguous run separately, and takes display-bin maxima only after smoothing.
This avoids viewport seams and keeps strand/contig boundaries separate. Existing
tasks work without a rescan. Sparse/unknown-stride tasks and catalog assemblies
keep their existing adapters. BigWig downloads remain raw, as labeled in the UI.

Verified against task `c2c63a3621e04d6ab7369582329dbbfc`: all 15,604 anchors remain,
and the 48 peaks plus 125 exported smoothed-window scores match within 5e-9.
The browser was checked at `NC_000913.3_excerpt_1_4000:528..712`. Thirty-nine
focused tests, TypeScript, scoped ESLint and an isolated production build passed.
This follow-up changes the local website only; no service deployment was needed.
Numerical verification is saved in `.codex-runtime/score-smoothing-20260908/`.

## Git integration validation

Integrated collaborator `origin/main` at `9502ceb`, preserving split queues,
load status, reverse-strand coordinates, and capability sharing across browser
sessions. Sharing receives both the access token and the result summary; the
worker retains SpawnWorker with queue-specific heartbeat and maintenance rules.

The integrated frontend's 750 tests passed after updating one stale raw-BigWig
download-copy assertion and rerunning its 17-test suite. TypeScript, full ESLint,
and the production build passed. All 71 Python service tests passed in an
isolated, network-disabled container using its own Redis, including the actual
SpawnWorker regression. Production containers and queues were not modified.
