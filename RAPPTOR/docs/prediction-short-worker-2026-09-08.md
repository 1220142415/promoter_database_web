# Short-sequence worker recovery — 2026-09-08

The online short-sequence worker was updated at **19:20:28 Asia/Shanghai**
after the user authorized its repair and restart. The original browser task
`725110dcb1f243f9860812b7763cc2df` now succeeds and returns both strand scores.

## Cause and fix

The live worker preloaded the PyTorch model, then used RQ's fork-based
`Worker`. The task stayed at `preparing_cgr` / 15%; its child waited in
`futex_wait_queue_me` while CPU time stopped increasing.

A two-line overlay replaces the `Worker` import and constructor with
`SpawnWorker`, matching the correction already present in the repository.
Every other source file remains from the previously deployed image. The
worker's environment, command, resources, user, network and persistent volume
were compared against the original container before startup.

## Verification

- Ran the existing `test_worker_process.py` regression against both images,
  using actual model preload and a PyTorch CGR tensor operation. The baseline
  reproduced the deadlock; the candidate passed. The tests used a separate
  Redis container with no external network and no production data volume.
- Requested warm shutdown before stopping only the identified stalled task.
  Requeued that same task after the new worker became ready. Its serialized
  job data, request-file SHA-256 and access-token hash were unchanged.
- The recovered task finished from `11:20:29.554690Z` to `11:20:35.933074Z`
  (about 6.4 seconds): 100 bp input, the complete 4,641,652 bp reference genome
  for CGR, and two scored windows, one per strand.
- Forward model score: `0.0058243670500814915`; reverse model score:
  `0.005988204386085272`. These are model scores, not calibrated probabilities.
- Verified byte counts and SHA-256 for all four artifacts: `scores.json`,
  `scores.gff3`, `peaks.gff3` and `summary.json`.
- The original local browser task displayed `Result ready`, 100%, both scores
  and protected result-download links. The input page remains available at
  `http://127.0.0.1:3000/predict`.
- The API, genome-scan worker and Redis container identities and images were
  unchanged. This rollout did not publish the website or change model weights.

## Deployment and rollback

Container: `rapptor-prediction-predict-worker`.

Image: `rapptor-prediction-cpu:predict-spawn-20260908`.

Image ID: `sha256:05ebb101f69d3d0dd6cbfa3dcc14ff3875f7e3ba3430121de5ee83240d847d6f`.

The stopped rollback container is
`rapptor-prediction-predict-worker-before-predict-spawn-20260908`; its restart
policy is disabled. The former image can reproduce the deadlock, so rollback
restores deployment state but does not provide the fix. Drain or gracefully
stop the active worker before restoring it, and preserve the shared data volume.

Server records are under `/home/syl/rapptor-predict-worker-spawn-20260908/`.
Container configuration and task-preservation snapshots stay on that server
with mode `0600`. Public manifests, test logs and artifact verification are
also stored locally in ignored `.codex-runtime/prediction-start-20260908/`.
