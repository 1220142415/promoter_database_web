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
must therefore include the **complete genome sequence**, not only a promoter
window or a short neighborhood. The worker computes one 128 × 128 CGR image
from that complete genome and uses it as the genome context for inference.

- `genome_scan`: upload the complete assembly FASTA; all contigs belong to the
  same genome and jointly form its CGR.
- `predict`: send the target sequence as `sequence` and the complete genome as
  `genome_context`.

Completeness cannot be inferred reliably from sequence text alone. The API
validates format, alphabet, ambiguity, byte size, and configured base limits,
then records that the caller asserted complete-genome input.

## Sequence-scan outputs

`genome_scan` accepts a configured `stride` and optional
`score_cutoff` in `[0, 1]`. The cutoff uses the strict rule
`score > score_cutoff` and applies only to sparse GFF3/JSON records. BigWig and
Parquet retain every window, so an export cutoff never changes the raw model-score
tracks. `top_k` remains unsupported.

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

## Local validation

```bash
docker-compose -f services/prediction/compose.yaml config
python -m pip install -r services/prediction/requirements-test.txt
PYTHONPATH=services/prediction/src python -m pytest services/prediction/tests
```

Production must enable Cloudflare ticket validation and use the same service
secret as the web application's internal ticket-consumption route.
