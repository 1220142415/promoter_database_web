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

- `genome_scan`: send the FASTA records to scan. For a whole assembly, that
  FASTA can also form the CGR. For a region or partial assembly, add either a
  cached `reference_accession` or the complete reference DNA in
  `genome_context`; the scan coordinates still come from the submitted FASTA.
- `predict`: send exactly one 100 bp `sequence` plus exactly one CGR source: a catalog-backed
  `reference_accession`, the complete sequence in `genome_context`, or an
  uploaded complete assembly in `fasta`. Custom `genome_context`/`fasta`
  requests may also include `cgr_png_base64`; that PNG is used directly after
  validation instead of regenerating it.

For a catalog accession, Docker validates
`/data/cgr-cache/<accession>/<cgr-version>/cgr.png`. Docker never downloads a
reference. A trusted Worker or synchronization program must query and populate
the protected reference-cache API before submitting prediction work. A cache
miss returns `REFERENCE_CGR_NOT_FOUND`; it never falls back to a URL from a job
request or ticket response. The public job schema does not accept a URL, local
path, CGR, or checksum from the browser.

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

The genome-scan worker uses RQ `SpawnWorker` so each scan starts in a fresh Python process.
Forking a worker after model preload can deadlock PyTorch CPU thread pools
during the CGR transform. Model readiness is checked in the parent; each scan
loads its own model runtime. This adds model startup time per scan.

The dedicated `prediction:predict` worker is the exception: it uses RQ
`SimpleWorker`, loads `ModelRuntime` once at container startup, and runs every
short-sequence task in that same long-lived process. CUDA/PyTorch initialization
therefore cannot be followed by a fork. `prediction:genome_scan` continues to
use `SpawnWorker` and keeps its per-task process isolation. If the persistent
predict process stops advancing, its watchdog first stages the normal safe
failure metadata and then exits the container with a failure status; Docker's
existing `restart: unless-stopped` policy starts a clean worker and reloads the
model.

Catalog CGRs retain their existing locked, SHA-256-verified disk cache. The API
validates only the manifest and PNG checksum before enqueueing; it never creates
a tensor. The persistent predict worker keeps at most 128 tensors in a process
LRU keyed by accession, CGR version, PNG SHA-256, path, and device. A changed
manifest or PNG hash therefore misses automatically, while repeated work for
the same immutable entry avoids disk decoding and host/device transfer.

Each short prediction writes one JSON timing line to worker stdout with
`queue_wait_ms`, `model_load_ms`, `cgr_load_ms`, `inference_ms`, `output_ms`,
`total_ms`, and `cgr_cache` (`memory_hit`, `disk_hit`, or `miss`). The worker
readiness line separately reports the one-time startup `model_load_ms`. Neither
line contains sequence data, tickets, access tokens, download credentials, or
reference URLs.

## Protected reference-cache API

These endpoints use the existing Docker-side `RAPPTOR_TICKET_SERVICE_SECRET`,
which is the same value stored by the Cloudflare Worker as
`RAPPTOR_PREDICTION_SERVICE_SECRET`:

```text
Authorization: Bearer <service secret>
```

The secret is only for the Worker or a trusted synchronization program and must
never be sent to a browser. Querying does not download, generate, enqueue a
prediction, or load a CGR tensor.

```http
GET /v1/reference-cache/GCF_000005845.1
Authorization: Bearer <service secret>
```

```json
{
  "accession": "GCF_000005845.1",
  "status": "ready",
  "cgr_version": "cgr-128-v1",
  "source_sha256": "64 lowercase hexadecimal characters"
}
```

`status` is `ready`, `missing`, `preparing`, or `invalid`. `ready` means the
manifest fields, accession/version, resolution, PNG presence, and PNG SHA-256
all passed validation. `source_sha256` can be `null` for missing or unreadable
entries. `memory_hit` is intentionally absent because it only describes a real
inference-process lookup.

Up to 100 accessions can be queried at once:

```http
POST /v1/reference-cache/query
Authorization: Bearer <service secret>
Content-Type: application/json

{"accessions":["GCF_000005845.1","GCF_000005845.2"]}
```

The response is `{"entries":[...]}` in request order. Accessions always include
their version and must match `GCF_` or `GCA_` plus nine digits, a dot, and a
numeric version.

Import a precomputed CGR with:

```http
POST /v1/reference-cache/GCF_000005845.1/imports
Authorization: Bearer <service secret>
Content-Type: image/png
X-Source-SHA256: <SHA-256 of the source genome FASTA>
X-CGR-SHA256: <SHA-256 of this PNG request body>
X-CGR-Version: cgr-128-v1

<128x128 PNG bytes>
```

Raw, uncompressed FASTA can instead be imported with `Content-Type:
text/x-fasta`, `X-Source-SHA256` set to the exact request-body SHA-256, and no
`X-CGR-SHA256`. The worker validates the FASTA and generates the CGR locally.
`cgr_sha256` is `null` while preparing and becomes the generated PNG SHA-256
when ready. For PNG imports, `X-Source-SHA256` preserves source-genome
provenance in the existing `fastaSha256` manifest field and `X-CGR-SHA256`
verifies the exact uploaded bytes. Multipart, archives, URLs, local paths, and
caller-selected destinations are not accepted.

A new import returns HTTP 202 and:

```json
{
  "import_id": "32 lowercase hexadecimal characters",
  "accession": "GCF_000005845.1",
  "status": "preparing",
  "cgr_version": "cgr-128-v1",
  "source_sha256": "...",
  "cgr_sha256": null,
  "error": null
}
```

Poll `GET /v1/reference-cache/imports/{import_id}` with the same Bearer secret.
It returns `preparing`, `ready`, or `failed`; failures contain only a stable code
and safe message. An already-ready identical import returns HTTP 200 `ready` and
does no work. An active identical import returns HTTP 202 with its existing ID.
The dedicated `prediction:reference-cache` worker checks the upload limit, both
hashes, PNG format and 128×128 dimensions, and verifies it through
`load_cgr_tensor` under the accession/version file lock. It publishes through a
temporary directory and atomic rename. Existing valid cache content is not
replaced after a failed import.

Stable cache API errors are `UNAUTHORIZED`, `CACHE_SERVICE_UNAVAILABLE`,
`INVALID_ACCESSION`, `INVALID_SOURCE_SHA256`, `INVALID_CGR_SHA256`,
`CGR_VERSION_MISMATCH`,
`INVALID_CONTENT_LENGTH`, `UNSUPPORTED_SOURCE_FORMAT`, `REFERENCE_UPLOAD_TOO_LARGE`,
`REFERENCE_CGR_CHECKSUM_MISMATCH`, `REFERENCE_CGR_INVALID`,
`REFERENCE_SOURCE_CHECKSUM_MISMATCH`, `REFERENCE_FASTA_INVALID`,
`REFERENCE_SOURCE_CONFLICT`, `REFERENCE_CGR_CONFLICT`,
`REFERENCE_IMPORT_BUSY`, `REFERENCE_IMPORT_NOT_FOUND`, and
`REFERENCE_IMPORT_FAILED`.

After an import is `ready`, normal prediction continues to send only
`reference_accession`; no import ID, hash, URL, or path is added to the browser
job contract. Normal prediction still requires its one-time `Ticket` header.
Ticket consumption still sends `mode`, actual billed `bases`, and
`referenceAccession`, so the Worker must authorize the accession and task kind.
A ready Docker cache does not authorize an accession and does not bypass Worker
quota checks. The Worker/synchronizer needs the accession, current CGR version,
source FASTA SHA-256, CGR PNG SHA-256, and PNG bytes only for the protected cache
workflow; no new browser field is required for catalog predictions.

For a custom genome, the existing JSON request can optionally carry the PNG:

```json
{
  "mode": "predict",
  "complete_genome": true,
  "sequence": "<exactly 100 bp>",
  "genome_context": "<complete genome sequence>",
  "cgr_png_base64": "<base64 encoded 128x128 PNG>"
}
```

`fasta` can be used instead of `genome_context`. The API validates and decodes
the PNG once, stores only `cgr.png` plus its SHA-256 in the private job directory,
and never returns it as an artifact. The input sequence/context and CGR expire
together under `RAPPTOR_FILE_RETENTION_SECONDS` (24 hours by default). Omitting
`cgr_png_base64` retains the original server-generated custom-CGR behavior for
backward compatibility. Catalog requests must omit this field and use the
protected cache import flow.

`genome_scan` accepts a configured-range `stride` and an optional
`score_cutoff` in `[0, 1]`. The promoter cutoff is strict (`>`) and defaults to
0.9 when the field is omitted. JSON and `scores.gff3` apply an explicitly
provided export cutoff; BigWig and Parquet retain every scanned score.
The score used by BigWig and `scores.gff3` is Gaussian-smoothed only at
`stride=1`; at larger strides it is the raw model score. `top_k` remains
unsupported.

When a scan produces BigWig tracks, the worker also atomically writes
`model-score-tracks.zip` with `ZIP_STORED`. It contains the existing tracks
under `model-score-tracks/` and is included in the artifact manifest; a
single-strand task includes only its plus track.

The API and worker automatically include promoter GFF3 postprocessing, even when
a client requests only BigWig/Parquet. At **stride 1**, each contig and strand is
ordered by reference coordinate, smoothed with Gaussian sigma 1 in `reflect` mode,
then passed to `scipy.signal.find_peaks` with a 10 bp minimum separation. Only
smoothed local maxima above the promoter cutoff are written to `promoters.gff3`.
At **stride > 1**, no Gaussian smoothing or local-maximum selection is performed:
every raw model window above the promoter cutoff is written as one promoter
interval. Adjacent 100 bp intervals may therefore overlap. A scan with no
promoters still produces a valid GFF3 header.
SciPy 1.15.3
is required.

Promoter GFF3 records use strand-aware 100 bp display intervals in 1-based closed
reference coordinates: `anchor-79 ... anchor+20` on `+` and
`anchor-20 ... anchor+79` on `-`. A display interval that would cross a contig boundary is
emitted as the single anchor base; it is never clipped or padded. The promoter
file contains only the GFF3 version declaration and standard coordinates, strand,
score, and promoter identifiers. New score artifacts use reference-oriented
`window_start_0based`, recorded by
`window_start_coordinate_system: "reference_0based"` in the summary, a GFF3
header, and Parquet metadata. Readers must preserve the older strand-oriented
window-start convention for legacy tasks. The first smoothed-peaks release
already used reference starts; its smoothing/peak-calling summary fields
identify that schema before the explicit marker was introduced.

The result page prefers `promoters.gff3`, displays **Predicted promoters**, and
loads the promoter track beside the precomputed score tracks without smoothing
them a second time. Existing jobs are not rescanned; legacy score tracks retain
their historical browser-side handling.

```json
{
  "mode": "genome_scan",
  "complete_genome": true,
  "fasta": ">region_or_assembly\nACGT...",
  "reference_accession": "GCF_000005845.1",
  "stride": 1,
  "score_cutoff": 0.9,
  "output_formats": ["bigwig", "gff3"]
}
```

For scan requests, `fasta` is always the sequence being evaluated. Exactly
zero or one separate CGR source may be supplied: `reference_accession`, or
`genome_context`. Omitting both retains the legacy behavior and derives the
CGR from the scan FASTA itself. Billing and ticket limits count only parsed
scan FASTA bases, not the separate complete reference.

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

The same token-protected job response includes `queue.ahead`, `queue.waiting`,
`queue.running`, `queue.worker_ready`, and `queue.estimated_wait_seconds`.
The estimate is time until that job starts, not time until it completes. It
remains `null` when workers are offline or recent measurements are insufficient
or stalled, and becomes `0` once the job starts.
The estimator keeps at most 120 seconds of bounded window-progress samples in
RQ metadata. Per queue, Redis retains a small set of recent completed timing
profiles containing measured windows/second plus preparation and output-writing
overhead. Queued workload is calculated from input lengths, stride, strand
count, and the model's configured window length, then assigned FIFO across the
currently heartbeating worker slots. No other job identifiers or inputs are
included in the response. `queue.ahead` continues to count only waiting jobs in
front of the current job and excludes running work.

While a job is running, the same response adds
`progress.estimated_remaining_seconds`: the estimated time until that job
finishes. It uses the same recent window throughput and measured preparation/output
overhead as the queue estimator. It is `null` when measurement is insufficient,
stalled, or the matching worker is offline, and `0` after successful completion.

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

For deployment, build one immutable image tag from the target commit, keep the
existing `.env` and named data/Redis volumes, and recreate `cache-worker`, `api`,
`predict-worker`, and `worker` from that same tag. Start `cache-worker` before
accepting imports. Do not use `docker compose down -v`; the reference cache is
inside the persistent data volume. Verify `/healthz`, `/readyz`, all worker
containers, one protected cache query, and an existing accession prediction.

To roll back, point those four services at the previously recorded image tag
and recreate them without removing either named volume. Cache manifests are
backward compatible, while imports queued by the new API should be allowed to
finish or be explicitly drained before removing `cache-worker`.

`test_worker_process.py` also provides an opt-in integration regression against
an isolated Redis instance. Set `RAPPTOR_TEST_REDIS_URL`, provide the normal
model assets, and run it with the service dependencies installed. It starts the
actual worker, waits for model preload, and checks that a CPU tensor job finishes
in its child process. Never point this test at production Redis.

Production must enable Cloudflare ticket validation and use the same service
secret as the web application's internal ticket-consumption route.

The internal consume request includes `mode` and optional `referenceAccession`.
Older Workers may ignore `mode`; current Docker remains compatible. Predict
ticket usage is the normalized 100 bp target length, while uploaded
`genome_scan` usage is the parsed total FASTA bases. For an allowed catalog
reference, the Worker may continue returning its current response during
rollout:

```json
{
  "allowed": true,
  "referenceSource": {
    "url": "https://huggingface.co/.../reference.fna",
    "sha256": "64 lowercase hexadecimal characters"
  }
}
```

Docker ignores `referenceSource` and never follows its URL. The Worker or an
external synchronization program must obtain or generate the matching CGR PNG
and send it through the protected cache import API before prediction submission.
