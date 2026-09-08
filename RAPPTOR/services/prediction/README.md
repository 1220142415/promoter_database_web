# RAPPTOR queued prediction service

This self-contained service lives beside the RAPPTOR web application but runs
as a separate Docker stack. `src/prediction_service` owns HTTP, validation,
queue, storage, and worker orchestration. `src/rapptor` contains only the model
runtime needed for inference. Model weights remain outside both source trees
under `model-assets/<version>` and are mounted read-only.

Job files are stored in the Compose-managed `rapptor-data` volume. The image
creates `/data` as UID/GID 10001, so API and worker share writable persistent
storage without changing permissions on a host directory. The model bind-mount
source must still be readable and traversable by the Docker daemon. This is
especially important for snap-packaged Docker, which cannot traverse arbitrary
mode-700 project directories. Point `RAPPTOR_MODEL_HOST_DIR` at a dedicated
read-only deployment directory when necessary.

## Required biological input

The current model is CGR-conditioned (`use_cgr_image: true`). Every prediction
must therefore identify or include the **complete genome**, not only a promoter
window or a short neighborhood. The worker uses its 128 × 128 CGR as the model
context.

- `genome_scan`: upload the complete assembly FASTA; all contigs belong to the
  same genome and jointly form its CGR.
- `predict`: send `sequence` plus exactly one CGR source: a catalog-backed
  `reference_accession`, the complete sequence in `genome_context`, or an
  uploaded complete assembly in `fasta`.

For a catalog accession, Docker first validates
`/data/cgr-cache/<accession>/<cgr-version>/cgr.png`. On a miss, ticket
consumption returns a Worker-resolved HTTPS FASTA URL and SHA-256. Docker
downloads that trusted URL, verifies the bytes, generates the cache through
`generate_cgr_from_fasta(..., resolution=128, raw_counts=False)`, and atomically
publishes the PNG and manifest. The public job schema does not accept a URL,
local path, CGR, or checksum from the browser.

Completeness cannot be inferred reliably from sequence text alone. The API
validates format, alphabet, ambiguity, byte size, and configured base limits,
then records that the caller asserted complete-genome input.

## Sequence-scan outputs

During `genome_scan`, `GET /v1/jobs/{job_id}` reports `progress.windows`,
`progress.total_windows`, and `progress.scan_percent`, plus the current `contig`
and `strand`. Counts include every evaluated window on the requested strands,
using each sequence length, the model window length, and the scan stride.
Each completed inference batch updates the counters; worker metadata is
published at most once per second, with immediate updates at strand boundaries
and the last batch. `progress.percent` remains overall task progress: a scan at
100% still needs the output-writing stage before the task succeeds.

These fields require an updated prediction worker image. Updating only the web
app cannot add batch updates to an older worker; the web app displays any
reported window count without inventing a scan percentage when totals are absent.

The worker uses RQ `SpawnWorker` so each task starts in a fresh Python process.
Forking a worker after model preload can deadlock PyTorch CPU thread pools
during the CGR transform. Model readiness is checked in the parent; each task
loads its own model runtime. This adds model startup time per task.

`genome_scan` accepts a configured-range `stride` and an optional
`score_cutoff` in `[0, 1]`. JSON exports raw scores strictly above this cutoff;
`scores.gff3` exports Gaussian-smoothed scores strictly above it. BigWig and
Parquet retain every raw scanned score. `top_k` remains unsupported.

At **stride 1**, the API and worker automatically include GFF3 postprocessing,
even when a client requests only BigWig/Parquet. Each contig and strand is ordered
by reference coordinate, smoothed with Gaussian sigma 1 (`reflect`), then passed
to `scipy.signal.find_peaks(distance=10)`. Peaks with smoothed model score
strictly **greater than 0.9** are written to `peaks.gff3`. This fixed peak cutoff
is independent of `score_cutoff`; a zero-peak scan still produces a valid GFF3
header. Other strides retain raw score outputs; requesting smoothed GFF3 at
those strides is rejected. SciPy 1.15.3 is required.

Peak GFF3 records are 1 bp anchors in 1-based reference coordinates. New score
artifacts use reference-oriented `window_start_0based`, recorded by
`window_start_coordinate_system: "reference_0based"` in the summary, a GFF3
header, and Parquet metadata. Readers must preserve the older strand-oriented
window-start convention for legacy tasks. The first smoothed-peaks release
already used reference starts; its smoothing/peak-calling summary fields
identify that schema before the explicit marker was introduced.

The result page prefers `peaks.gff3`, displays **Called peaks**, and loads the
peak track beside model-score tracks. For a recorded stride of 1, the browser
smooths the raw scores with the same Gaussian sigma 1 and reflect boundaries;
BigWig downloads retain every raw score. The form requests the fixed peak settings
automatically. Existing jobs are not rescanned.

```json
{
  "mode": "genome_scan",
  "complete_genome": true,
  "fasta": ">contig\nACGT...",
  "stride": 1,
  "score_cutoff": 0.9,
  "output_formats": ["bigwig", "parquet", "gff3"]
}
```

`GET /v1/models/current` publishes the active stride limits, cutoff range and
operator, affected formats, and default output formats for frontend clients.

Set `RAPPTOR_MAX_REQUEST_BYTES` to the same positive byte value in the web app
and this service. Both default to `12582912` bytes (12 MiB).

Completed jobs return an artifact manifest. Each artifact can be read from:

```text
GET /v1/jobs/{job_id}/artifacts/{filename}
X-Job-Token: <job access token>
Range: bytes=<start>-<end>
```

The artifact endpoint returns `206 Partial Content` for valid byte ranges and
supports `HEAD`, so JBrowse's `BigWigAdapter` can read only the visible region.
The browser must not cache a whole multi-hundred-megabyte BigWig as a Blob.

The Next.js same-origin proxy is available at `/api/predictions/jobs`; set
`RAPPTOR_PREDICTION_SERVICE_URL` in the web deployment. It forwards status and
artifact Range requests without buffering the response body.

## Retention and permanent records

Full-position prediction artifacts default to a 24-hour retention period
(`RAPPTOR_FILE_RETENTION_SECONDS=86400`). The cleanup thread only removes
terminal job directories after their recorded expiry; `0` disables deletion.
Redis/RQ metadata still uses `RAPPTOR_RESULT_TTL_SECONDS` (seven days by
default). Configure `RAPPTOR_JOB_CALLBACK_URL` and
`RAPPTOR_JOB_CALLBACK_SECRET` to write sequence-free queued/running/final
metadata to D1 through `/api/internal/prediction-jobs`. D1 stores the artifact
manifest and hashes, never FASTA, CGR, model weights, or BigWig bytes.

## Service workload status

`GET /v1/status` returns aggregate queued/running job counts and input-size
statistics without exposing job IDs, sequences, tickets, or user data. A
token-protected `GET /v1/jobs/{job_id}` response also includes that job's
`mode` and `input_bases`.

The same token-protected job response includes
`queue.estimated_wait_seconds`, an estimate of time until that job starts (not
time until it completes). It remains `null` when workers are offline or recent
measurements are insufficient or stalled, and becomes `0` once the job starts.
The estimator keeps at most 120 seconds of bounded window-progress samples in
RQ metadata. Per queue, Redis retains a small set of recent completed timing
profiles containing measured windows/second plus preparation and output-writing
overhead. Queued workload is calculated from input lengths, stride, strand
count, and the model's configured window length, then assigned FIFO across the
currently heartbeating worker slots. No other job identifiers or inputs are
included in the response. `queue.ahead` continues to count only waiting jobs in
front of the current job and excludes running work.

RQ's former fixed 3,600-second wall-clock timeout is disabled (`job_timeout=-1`).
Workers repair that legacy timeout on jobs that are still queued when they
start. A separate watchdog defaults to 3,600 seconds of *no useful progress*;
stage transitions, increasing completion percentage, or increasing processed
window counts reset that timer. A per-job child heartbeat is tracked separately,
so a live process that is no longer advancing does not occupy a worker forever.
The service reports preparation, inference/scanning, output writing, and final
completion as distinct progress points. Configure only the inactivity limit
with `RAPPTOR_JOB_STALL_TIMEOUT_SECONDS`; the wall-clock timeout must remain
`RAPPTOR_JOB_TIMEOUT_SECONDS=-1`.

Failed jobs keep their last valid progress snapshot and percentage under
`progress.last_valid_progress`; failure never reports 100%. `error.code`
distinguishes ordinary `JOB_FAILED`, `JOB_PROGRESS_STALLED`, and
`JOB_PROCESS_HEARTBEAT_LOST` failures while messages remain short and safe.

## Local validation

```bash
docker-compose -f services/prediction/compose.yaml config
python -m pip install -r services/prediction/requirements-test.txt
PYTHONPATH=services/prediction/src python -m pytest services/prediction/tests
```

`test_worker_process.py` also provides an opt-in integration regression against
an isolated Redis instance. Set `RAPPTOR_TEST_REDIS_URL`, provide the normal
model assets, and run it with the service dependencies installed. It starts the
actual worker, waits for model preload, and checks that a CPU tensor job finishes
in its child process. Never point this test at production Redis.

Production must enable Cloudflare ticket validation and use the same service
secret as the web application's internal ticket-consumption route.

The internal consume request includes optional `referenceAccession`. For an
allowed catalog reference, the Worker resolves D1 metadata and returns:

```json
{
  "allowed": true,
  "referenceSource": {
    "url": "https://huggingface.co/.../reference.fna",
    "sha256": "64 lowercase hexadecimal characters"
  }
}
```
