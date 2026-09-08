# Online scan progress verification — 2026-09-08

The genome-scan worker at `https://4090server.duolalab.qzz.io` now publishes
batch progress. The local result page consumes the real counts every three
seconds. No Cloudflare website deployment was performed.

## Git and deployment scope

`origin/main` was fetched at `9502ceb` (`feat(prediction): split CPU workers and
expose load status`), six commits ahead of this checkout's `b40fd09`. The other
new commits include reverse-strand output and shared-browser-view fixes.
The fetch did not merge or overwrite local edits.

The running service was inspected separately. It already had independent
`prediction:predict` and `prediction:genome_scan` queues, but its API and output
code did not fully match `origin/main`. The progress deployment therefore used
an overlay on the actual running image, preserving its output semantics,
model assets, authentication, API, Redis, and data volume. It does not deploy
all the changes currently present in Git or the local result-page checkout.

Updated container: `rapptor-prediction-worker`.

Final image: `rapptor-prediction-cpu:scan-progress-spawn-20260908`.

Image ID: `sha256:409e3299b2b68e19e2ffc05644594624b95e07fba691fae24fed1df9a6975f48`.

The image adds progress callbacks in `scan_gtdb_shared.py` and `runtime.py`,
window accounting in `scan_progress.py` and `jobs.py`, and uses `SpawnWorker`
in `worker.py`. Container environment, resource limits, network, user, mounts,
and restart policy were compared with the previous container before startup.

## Runtime issue found during verification

The initial live task stalled in `preparing_cgr` with its child waiting on a
futex and negligible CPU usage. An isolated container reproduced the cause:
after preloading the production model with 28 CPU threads, a forked child
blocked on `torch.log1p(torch.ones((1, 128, 128)))`. The equivalent operation
completed in a fresh Python child.

RQ's native `SpawnWorker` avoids inheriting that thread-pool state. The parent
still checks model readiness; each task initializes its own runtime, adding
model startup time. Only the session-created verification task was stopped
and requeued after this correction. No other task was stopped.

The short-sequence production worker was not replaced. Its existing fork-based
startup has the same structural risk, but a live short-sequence failure was
not tested in this run. Updating that worker requires a separate authorized
deployment. The local shared worker source includes the spawn correction for
the next coordinated code release.

## Validation

Ten server-side tests passed without skips:

- Four window-count/progress-accounting cases.
- One actual PyTorch partial-batch callback test, with identical output scores.
- Four before/after scan-output comparisons: forward, both strands, multiple
  contigs including a short contig, and no eligible windows. Artifact hashes
  matched; summary comparison excluded the completion timestamp.
- One integration test using the actual preloaded RQ worker and a separate
  Redis container with no connection to production Redis. The tensor job
  completed in the spawned child. Temporary test containers were removed.

Live verification task: `64a64df24a0c42ec819166c709eeab9f`.

Input: the existing E. coli K-12 MG1655 reference example, `NC_000913.3`,
4,641,652 bp; 100 bp model windows, 20 bp stride, both strands.

Expected total: `2 × (floor((4,641,652 − 100) / 20) + 1) = 464,156` windows.

The actual local page displayed increasing counts within a strand:
`20,256` then `61,568` on the forward strand, followed by `244,686` and
`442,862` on the reverse strand. The total remained `464,156`.

The task succeeded at `2026-09-08T06:44:00Z` (14:44 Beijing time), after about
6 minutes 11 seconds from its restart. Final progress reported `464,156 /
464,156`, scan `100%`, and overall `100%`. Parquet contained exactly `464,156`
rows; each strand's BigWig covered `232,078` one-base anchors on `NC_000913.3`.
All six artifact sizes and SHA-256 values matched the returned manifest.

The real local browser displayed both score tracks and an individual score
tooltip, then remained open on the completed task. The ZIP download link was
activated; a saved ZIP was not independently inspected. This deployment
preserved the older service's default BigWig/Parquet output, so the verification
task did not produce GFF3 or record an export cutoff.

Final readiness returned HTTP 200. The API and short-sequence worker retained
their original `separated-workers-20260908` image.

## Evidence and rollback

Local deployment source snapshots, precise overlay patches, test logs and
manifests are in ignored `.codex-runtime/scan-progress-deploy-20260908/`.
Corresponding server records are under:

- `/home/syl/rapptor-scan-progress-20260908/`
- `/home/syl/rapptor-scan-progress-spawn-20260908/`

Private configuration backups remain on the server with mode `0600`; they
are not included in these records or Git. Stopped rollback containers retain
the original image and configuration:

- `rapptor-prediction-worker-before-scan-progress-20260908`: original deployment.
- `rapptor-prediction-worker-before-scan-progress-spawn-20260908`: progress-only
  image before the spawn correction; this version reproduced the deadlock.

Both backups have restart disabled. A rollback must drain or gracefully stop
the active worker, preserve it under a different name, restore the chosen
backup to `rapptor-prediction-worker`, and restore its `unless-stopped` restart
policy. Do not run two maintenance workers or delete the shared data volume.

Before a future full deployment, combine the local progress/spawn corrections
with the latest collaborator changes and validate that integrated source.
Deploying the current Git image alone would lose these uncommitted corrections.
