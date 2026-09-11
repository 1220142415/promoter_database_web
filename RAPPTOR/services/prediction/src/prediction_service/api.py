from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import re
import uuid
from io import BytesIO
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import lru_cache

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from redis.exceptions import RedisError
from rq import Queue
from rq.job import Job
from rq.registry import FailedJobRegistry, FinishedJobRegistry, StartedJobRegistry
from PIL import Image, UnidentifiedImageError

from .config import SETTINGS
from .callbacks import persist_job_event
from .cgr_cache import ReferenceCgrNotFound, validate_reference_cgr
from .jobs import process_job
from .metrics import cpu_history, latest_cpu_sample, sample_cpu_loop, stop_sampler
from .queueing import get_queue, get_redis_connection
from .queue_eta import estimate_remaining_seconds, estimate_wait_seconds
from .reference_cache import (
    ReferenceCacheError,
    abort_import,
    begin_import,
    cache_status,
    enqueue_import,
    get_import_state,
    import_dir,
    public_import_state,
)
from .scan_progress import count_scan_windows
from .schemas import (
    JobCreated,
    JobStatus,
    JobSubmission,
    ReferenceCacheImportStatus,
    ReferenceCacheQuery,
    ReferenceCacheQueryResult,
    ReferenceCacheStatus,
)
from .security import new_access_token, token_digest, token_matches
from .storage import JobStorage
from .tickets import ReferenceSourceUnavailable, TicketRejected, consume_ticket, parse_ticket_header
from .validation import InputValidationError, validate_fasta, validate_sequence


@asynccontextmanager
async def lifespan(_app: FastAPI):
    sampler = asyncio.create_task(sample_cpu_loop())
    try:
        yield
    finally:
        await stop_sampler(sampler)


app = FastAPI(title="RAPPTOR Prediction Service", version="0.1.0", lifespan=lifespan)

ARTIFACT_CONTENT_TYPES = {
    ".bw": "application/x-bigwig",
    ".parquet": "application/vnd.apache.parquet",
    ".gff3": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".zip": "application/zip",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def artifact_expiry() -> str | None:
    if not SETTINGS.file_retention_seconds:
        return None
    return datetime.fromtimestamp(
        datetime.now(timezone.utc).timestamp() + SETTINGS.file_retention_seconds,
        timezone.utc,
    ).isoformat()


def _http_error(status: int, code: str, message: str):
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


def _require_cache_service(authorization: str | None) -> None:
    secret = SETTINGS.ticket_service_secret
    if not secret:
        _http_error(503, "CACHE_SERVICE_UNAVAILABLE", "Reference cache service is unavailable.")
    scheme, separator, value = (authorization or "").partition(" ")
    if not separator or scheme.lower() != "bearer" or not hmac.compare_digest(value.strip(), secret):
        _http_error(401, "UNAUTHORIZED", "Service authentication is required.")


def _reference_cache_error(exc: ReferenceCacheError):
    status = {
        "INVALID_ACCESSION": 400,
        "INVALID_SOURCE_SHA256": 400,
        "INVALID_CGR_SHA256": 400,
        "UNSUPPORTED_SOURCE_FORMAT": 415,
        "REFERENCE_UPLOAD_TOO_LARGE": 413,
        "REFERENCE_CGR_CHECKSUM_MISMATCH": 422,
        "REFERENCE_SOURCE_CONFLICT": 409,
        "REFERENCE_CGR_CONFLICT": 409,
        "REFERENCE_IMPORT_BUSY": 429,
        "REFERENCE_IMPORT_NOT_FOUND": 404,
    }.get(exc.code, 400)
    _http_error(status, exc.code, exc.message)


def _status_name(job: Job) -> str:
    try:
        status = job.get_status(refresh=True)
    except Exception:
        return "unknown"
    raw_status = getattr(status, "value", status)
    mapping = {
        "queued": "queued",
        "deferred": "queued",
        "scheduled": "queued",
        "started": "running",
        "finished": "succeeded",
        "failed": "failed",
        "stopped": "failed",
        "canceled": "failed",
    }
    return mapping.get(str(raw_status), "unknown")


def _worker_ready(connection) -> bool:
    return all(_workers_status(connection).values())


def _workers_status(connection) -> dict[str, bool]:
    return {
        "predict": bool(connection.keys(f"rapptor:worker:{SETTINGS.predict_queue_name}:*:ready")),
        "genome_scan": bool(connection.keys(f"rapptor:worker:{SETTINGS.scan_queue_name}:*:ready")),
    }


def _queues(connection) -> dict[str, Queue]:
    return {mode: get_queue(connection, mode) for mode in ("predict", "genome_scan")}


def _queue_counts(connection) -> dict[str, int]:
    return {mode: queue.count for mode, queue in _queues(connection).items()}


def _queue_status(connection, job: Job, status: str) -> dict:
    response = {
        "ahead": None,
        "estimated_wait_seconds": None,
        "waiting": None,
        "running": None,
        "worker_ready": None,
        "total_waiting": None,
        "waiting_by_mode": None,
    }
    try:
        queues = _queues(connection)
        unique_queues = {queue.name: queue for queue in queues.values()}
        queued_ids = {name: queue.get_job_ids() for name, queue in unique_queues.items()}
        own_ids = queued_ids.get(job.origin)
        if own_ids is None:
            own_ids = Queue(job.origin, connection=connection).get_job_ids()
        response.update({
            "waiting": len(own_ids),
            "total_waiting": sum(len(ids) for ids in queued_ids.values()),
            "waiting_by_mode": {mode: len(queued_ids[queue.name]) for mode, queue in queues.items()},
        })
    except Exception:
        return response
    ahead = None
    if status == "queued":
        try:
            ahead = own_ids.index(job.id)
        except ValueError:
            pass
    response["ahead"] = ahead
    try:
        response["estimated_wait_seconds"] = estimate_wait_seconds(connection, job, status, own_ids)
    except Exception:
        pass
    try:
        response["running"] = len(
            StartedJobRegistry(name=job.origin, connection=connection).get_job_ids()
        )
    except Exception:
        pass
    try:
        mode = job.meta.get("mode")
        response["worker_ready"] = _workers_status(connection).get(mode)
    except Exception:
        pass
    return response


@lru_cache(maxsize=1)
def _model_window_length() -> int | None:
    try:
        config = json.loads((SETTINGS.model_dir / "model_config.json").read_text(encoding="utf-8"))
        value = int(config["seq_length"])
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return None
    return value if value > 0 else None


def _request_window_count(request_payload: dict) -> int | None:
    window_length = _model_window_length()
    if window_length is None:
        return None
    reverse = bool(request_payload.get("reverse_complementary", True))
    if request_payload["mode"] == "predict":
        lengths = (len(request_payload["sequence"]),)
        stride = 1
    else:
        try:
            validated = validate_fasta(
                request_payload["fasta"],
                max_bases=SETTINGS.max_genome_bases,
                max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
            )
        except (KeyError, InputValidationError):
            return None
        lengths = (len(record.sequence) for record in validated.records)
        stride = int(request_payload["stride"])
    return count_scan_windows(lengths, window_length, stride, reverse)


def _workload_snapshot(job_ids: list[str], connection) -> dict:
    jobs = Job.fetch_many(job_ids, connection=connection)
    input_bases = [
        int(job.meta["input_bases"])
        for job in jobs
        if job is not None and isinstance(job.meta.get("input_bases"), int)
    ]
    return {
        "jobs": len(job_ids),
        "input_bases_known_jobs": len(input_bases),
        "input_bases_total": sum(input_bases),
        "input_bases_min": min(input_bases, default=0),
        "input_bases_max": max(input_bases, default=0),
    }


def _parse_range(value: str | None, size: int):
    if not value:
        return None
    if "," in value:
        return "invalid"
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if not match or (not match.group(1) and not match.group(2)):
        return "invalid"
    if match.group(1):
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else size - 1
    else:
        suffix = int(match.group(2))
        if suffix <= 0:
            return "invalid"
        start = max(0, size - suffix)
        end = size - 1
    if start < 0 or end < start or start >= size:
        return "invalid"
    return start, min(end, size - 1)


def _stream_file(path, start: int, end: int, chunk_size: int = 1024 * 1024):
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = end - start + 1
        while remaining:
            chunk = handle.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _validate_submission(payload: JobSubmission) -> tuple[dict, int]:
    request = payload.model_dump()
    batch_size = int(payload.batch_size or SETTINGS.default_batch_size)
    if batch_size > SETTINGS.max_batch_size:
        raise InputValidationError(f"Batch size must be at most {SETTINGS.max_batch_size}.")
    request["batch_size"] = batch_size

    if payload.mode == "predict":
        sequence = validate_sequence(
            payload.sequence or "",
            label="sequence",
            min_bases=100,
            max_bases=100,
            max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
        )
        request["sequence"] = sequence
        request["stride"] = 1
        if payload.reference_accession is not None:
            request["cgr_source"] = "reference_accession"
            return request, len(sequence)
        request.pop("reference_accession", None)
        if payload.cgr_png_base64 is not None:
            cgr_png = _decode_cgr_png(payload.cgr_png_base64)
            request["cgr_png_base64"] = base64.b64encode(cgr_png).decode("ascii")
            request["cgr_sha256"] = hashlib.sha256(cgr_png).hexdigest()
            request["cgr_source"] = "uploaded_cgr_png"
        if payload.fasta is not None:
            validated = validate_fasta(
                payload.fasta,
                max_bases=SETTINGS.max_genome_bases,
                max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
            )
            request["fasta"] = validated.to_fasta()
            if payload.cgr_png_base64 is None:
                request["cgr_source"] = "uploaded_complete_genome_fasta"
            return request, len(sequence)
        genome_context = validate_sequence(
            payload.genome_context or "",
            label="genome_context",
            min_bases=100,
            max_bases=SETTINGS.max_genome_bases,
            max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
        )
        request["genome_context"] = genome_context
        if payload.cgr_png_base64 is None:
            request["cgr_source"] = "complete_genome_sequence"
        return request, len(sequence)

    request.pop("sequence", None)
    validated = validate_fasta(
        payload.fasta or "",
        max_bases=SETTINGS.max_genome_bases,
        max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
    )
    stride = int(payload.stride or SETTINGS.default_scan_stride)
    if stride < SETTINGS.min_scan_stride:
        raise InputValidationError(f"Stride must be at least {SETTINGS.min_scan_stride} bp.")
    if stride > SETTINGS.max_scan_stride:
        raise InputValidationError(f"Stride must be at most {SETTINGS.max_scan_stride} bp.")
    request["fasta"] = validated.to_fasta()
    if payload.reference_accession is not None:
        request["cgr_source"] = "reference_accession"
    elif payload.genome_context is not None:
        request["genome_context"] = validate_sequence(
            payload.genome_context,
            label="genome_context",
            min_bases=100,
            max_bases=SETTINGS.max_genome_bases,
            max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
        )
        request["cgr_source"] = "separate_complete_genome_sequence"
    else:
        request.pop("reference_accession", None)
        request.pop("genome_context", None)
        request["cgr_source"] = "complete_genome_assembly_fasta"
    request["stride"] = stride
    request["score_cutoff"] = float(payload.score_cutoff) if payload.score_cutoff is not None else None
    from .formats import scan_output_formats
    request["output_formats"] = list(scan_output_formats(payload.output_formats, stride))
    return request, validated.total_bases


def _decode_cgr_png(encoded: str) -> bytes:
    try:
        payload = base64.b64decode(encoded, validate=True)
        if not payload or len(payload) > SETTINGS.reference_cache_max_upload_bytes:
            raise ValueError
        with Image.open(BytesIO(payload)) as image:
            if image.format != "PNG" or image.size != (128, 128):
                raise ValueError
            image.verify()
    except (binascii.Error, OSError, UnidentifiedImageError, ValueError, TypeError):
        raise InputValidationError("cgr_png_base64 must be a valid 128x128 PNG.") from None
    return payload


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    if isinstance(exc.detail, dict) and "code" in exc.detail:
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
    return JSONResponse(status_code=exc.status_code, content={"error": {"code": "HTTP_ERROR", "message": str(exc.detail)}})


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/v1/models/current")
def current_model():
    return {
        "model_version": SETTINGS.model_version,
        "conditioning": "CGR_128x128",
        "requires_complete_genome": True,
        "genome_scan": {
            "default_stride": SETTINGS.default_scan_stride,
            "min_stride": SETTINGS.min_scan_stride,
            "max_stride": SETTINGS.max_scan_stride,
            "score_cutoff": {
                "default": None,
                "minimum": 0.0,
                "maximum": 1.0,
                "operator": ">",
                "applies_to": ["gff3", "json", "promoters.gff3"],
                "unfiltered_formats": ["bigwig", "parquet"],
            },
            "gff3_postprocessing": {
                "required_stride": None,
                "supported_stride": {"minimum": SETTINGS.min_scan_stride, "maximum": SETTINGS.max_scan_stride},
                "automatic": True,
                "smoothing": {"method": "gaussian", "sigma": 1, "mode": "reflect"},
                "peaks": {
                    "distance": 10,
                    "distance_unit": "bp",
                    "sample_distance_rule": "ceil(distance_bp/stride)",
                    "coordinate_resolution": "stride",
                    "default_cutoff": 0.9,
                    "configurable_cutoff": True,
                    "operator": ">",
                    "filename": "promoters.gff3",
                    "display_interval": {
                        "coordinate_system": "1-based closed",
                        "upstream_bp": 79,
                        "anchor_bp": 1,
                        "downstream_bp": 20,
                        "boundary_rule": "single anchor marked unavailable",
                    },
                    "scoring_window": {
                        "coordinate_system": "reference 0-based half-open",
                        "upstream_bp": 80,
                        "downstream_bp": 20,
                    },
                },
            },
            "bigwig_processing": {
                "smoothing": {"method": "gaussian", "sigma": 1, "mode": "reflect"},
                "retains_all_scores": True,
            },
            "output_formats": ["bigwig", "parquet", "gff3", "json"],
            "default_output_formats": ["bigwig", "parquet"],
            "reverse_complementary": {"default": True},
            "batch_size": {
                "default": SETTINGS.default_batch_size,
                "minimum": 1,
                "maximum": SETTINGS.max_batch_size,
            },
            "unsupported_filters": ["top_k", "peak_distance"],
        },
        "complete_genome_field": {
            "predict": ["genome_context", "reference_accession", "fasta"],
            "genome_scan": "fasta",
        },
        "completeness_validation": "submitter_assertion",
    }


@app.get("/readyz")
def readyz():
    try:
        connection = get_redis_connection()
        connection.ping()
        worker_ready = _worker_ready(connection)
    except RedisError:
        return JSONResponse(status_code=503, content={"status": "not_ready", "redis": False, "worker": False})
    if SETTINGS.require_worker_for_ready and not worker_ready:
        return JSONResponse(status_code=503, content={"status": "not_ready", "redis": True, "worker": False})
    return {"status": "ready", "redis": True, "worker": worker_ready}


@app.get(
    "/v1/reference-cache/imports/{import_id}",
    response_model=ReferenceCacheImportStatus,
)
def reference_cache_import_status(
    import_id: str,
    authorization: str | None = Header(default=None),
):
    _require_cache_service(authorization)
    try:
        connection = get_redis_connection()
        connection.ping()
        return public_import_state(get_import_state(connection, import_id))
    except ReferenceCacheError as exc:
        _reference_cache_error(exc)
    except RedisError:
        _http_error(503, "CACHE_SERVICE_UNAVAILABLE", "Reference cache service is unavailable.")


@app.get(
    "/v1/reference-cache/{accession}",
    response_model=ReferenceCacheStatus,
)
def get_reference_cache(
    accession: str,
    authorization: str | None = Header(default=None),
):
    _require_cache_service(authorization)
    try:
        connection = get_redis_connection()
        connection.ping()
        return cache_status(connection, accession)
    except ReferenceCacheError as exc:
        _reference_cache_error(exc)
    except RedisError:
        _http_error(503, "CACHE_SERVICE_UNAVAILABLE", "Reference cache service is unavailable.")


@app.post(
    "/v1/reference-cache/query",
    response_model=ReferenceCacheQueryResult,
)
def query_reference_cache(
    payload: ReferenceCacheQuery,
    authorization: str | None = Header(default=None),
):
    _require_cache_service(authorization)
    try:
        connection = get_redis_connection()
        connection.ping()
        return {"entries": [cache_status(connection, accession) for accession in payload.accessions]}
    except ReferenceCacheError as exc:
        _reference_cache_error(exc)
    except RedisError:
        _http_error(503, "CACHE_SERVICE_UNAVAILABLE", "Reference cache service is unavailable.")


@app.post(
    "/v1/reference-cache/{accession}/imports",
    response_model=ReferenceCacheImportStatus,
    status_code=202,
)
async def import_reference_cache(
    accession: str,
    request: Request,
    authorization: str | None = Header(default=None),
    x_source_sha256: str | None = Header(default=None, alias="X-Source-SHA256"),
    x_cgr_sha256: str | None = Header(default=None, alias="X-CGR-SHA256"),
    x_cgr_version: str | None = Header(default=None, alias="X-CGR-Version"),
):
    _require_cache_service(authorization)
    if x_cgr_version != SETTINGS.cgr_version:
        _http_error(400, "CGR_VERSION_MISMATCH", "CGR version does not match this service.")
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            parsed_content_length = int(content_length)
            if parsed_content_length < 0:
                raise ValueError
            if parsed_content_length > SETTINGS.reference_cache_max_upload_bytes:
                _http_error(413, "REFERENCE_UPLOAD_TOO_LARGE", "Reference upload is too large.")
        except ValueError:
            _http_error(400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.")

    try:
        connection = get_redis_connection()
        connection.ping()
        state, created = begin_import(
            connection,
            uuid.uuid4().hex,
            accession,
            x_source_sha256 or "",
            x_cgr_sha256,
            request.headers.get("content-type", ""),
        )
    except ReferenceCacheError as exc:
        _reference_cache_error(exc)
    except RedisError:
        _http_error(503, "CACHE_SERVICE_UNAVAILABLE", "Reference cache service is unavailable.")

    if not created:
        return JSONResponse(
            status_code=200 if state["status"] == "ready" else 202,
            content=public_import_state(state),
        )

    directory = import_dir(state["import_id"])
    upload_path = directory / "upload"
    digest = hashlib.sha256()
    size = 0
    try:
        directory.mkdir(parents=True, exist_ok=False)
        with upload_path.open("wb") as destination:
            async for chunk in request.stream():
                if not chunk:
                    continue
                size += len(chunk)
                if size > SETTINGS.reference_cache_max_upload_bytes:
                    raise ReferenceCacheError(
                        "REFERENCE_UPLOAD_TOO_LARGE", "Reference upload is too large."
                    )
                digest.update(chunk)
                destination.write(chunk)
        if state["content_type"] == "image/png" and digest.hexdigest() != state["cgr_sha256"]:
            raise ReferenceCacheError(
                "REFERENCE_CGR_CHECKSUM_MISMATCH", "CGR PNG SHA-256 does not match."
            )
        if state["content_type"] == "text/x-fasta" and digest.hexdigest() != state["source_sha256"]:
            raise ReferenceCacheError(
                "REFERENCE_SOURCE_CHECKSUM_MISMATCH", "FASTA SHA-256 does not match."
            )
        enqueue_import(connection, state["import_id"])
    except ReferenceCacheError as exc:
        abort_import(connection, state)
        _reference_cache_error(exc)
    except Exception:
        abort_import(connection, state)
        _http_error(503, "CACHE_SERVICE_UNAVAILABLE", "Reference import could not be queued.")
    return public_import_state(state)


@app.get("/v1/status")
def service_status(history: str | None = None, bucket: str = "30m"):
    if history not in (None, "6h") or bucket != "30m":
        _http_error(400, "INVALID_STATUS_WINDOW", "supported history and bucket are 6h and 30m")
    try:
        connection = get_redis_connection()
        connection.ping()
        latest = latest_cpu_sample(connection)
        queues = _queues(connection)
        workers = _workers_status(connection)
        queued_ids = {mode: queue.get_job_ids() for mode, queue in queues.items()}
        running_ids = {
            mode: StartedJobRegistry(name=queue.name, connection=connection).get_job_ids()
            for mode, queue in queues.items()
        }
        response = {
            "status": "ready" if all(workers.values()) else "degraded",
            "model_version": SETTINGS.model_version,
            "worker_ready": all(workers.values()),
            "sampled_at": (
                datetime.fromtimestamp(float(latest["sampled_at"]), timezone.utc).isoformat()
                if latest else None
            ),
            "current": {
                "window_seconds": 5,
                "cpu_percent": float(latest["cpu_percent"]) if latest else None,
            },
            "queues": {mode: len(job_ids) for mode, job_ids in queued_ids.items()},
            "workers": workers,
            "workload": {
                "queued": {
                    mode: _workload_snapshot(job_ids, connection)
                    for mode, job_ids in queued_ids.items()
                },
                "running": {
                    mode: _workload_snapshot(job_ids, connection)
                    for mode, job_ids in running_ids.items()
                },
            },
            "limits": {
                "max_queued_jobs": SETTINGS.max_queue_length,
                "max_predict_bases": 100,
                "max_genome_bases": SETTINGS.max_genome_bases,
                "max_request_bytes": SETTINGS.max_request_bytes,
            },
        }
        if history == "6h":
            response["history"] = {
                "window_hours": 6,
                "bucket_minutes": 30,
                "points": cpu_history(connection),
            }
        return response
    except RedisError:
        _http_error(503, "STATUS_UNAVAILABLE", "server status is unavailable")


@app.post("/v1/jobs", response_model=JobCreated, status_code=202)
async def submit_job(payload: JobSubmission, authorization: str | None = Header(default=None)):
    try:
        request_payload, billed_bases = _validate_submission(payload)
    except ReferenceCgrNotFound:
        _http_error(404, "REFERENCE_CGR_NOT_FOUND", "Reference CGR is unavailable.")
    except InputValidationError as exc:
        _http_error(400, "INVALID_INPUT", str(exc))

    if len(json.dumps(request_payload).encode("utf-8")) > SETTINGS.max_request_bytes:
        _http_error(413, "INPUT_TOO_LARGE", "Request exceeds the configured size limit.")

    ticket = parse_ticket_header(authorization)
    try:
        await consume_ticket(
            ticket,
            model_version=SETTINGS.model_version,
            bases=billed_bases,
            mode=payload.mode,
            reference_accession=payload.reference_accession,
        )
    except ReferenceSourceUnavailable:
        _http_error(404, "REFERENCE_CGR_NOT_FOUND", "Reference CGR is unavailable.")
    except TicketRejected as exc:
        _http_error(401, "INVALID_TICKET", str(exc))
    except RuntimeError as exc:
        _http_error(503, "TICKET_SERVICE_UNAVAILABLE", str(exc))

    if payload.reference_accession is not None:
        try:
            validate_reference_cgr(payload.reference_accession)
        except ReferenceCgrNotFound:
            _http_error(404, "REFERENCE_CGR_NOT_FOUND", "Reference CGR is unavailable.")

    connection = get_redis_connection()
    try:
        connection.ping()
        queues = _queues(connection)
        unique_queues = {queue.name: queue for queue in queues.values()}
        if sum(queue.count for queue in unique_queues.values()) >= SETTINGS.max_queue_length:
            _http_error(429, "RATE_LIMITED", "Prediction queue is full.")
        queue = queues[payload.mode]
    except RedisError:
        _http_error(503, "QUEUE_UNAVAILABLE", "Prediction queue is unavailable.")

    job_id = uuid.uuid4().hex
    access_token = new_access_token()
    storage = JobStorage(SETTINGS.data_root)
    try:
        storage.create(job_id)
        cgr_png_base64 = request_payload.pop("cgr_png_base64", None)
        if cgr_png_base64 is not None:
            storage.write_bytes(job_id, "cgr.png", _decode_cgr_png(cgr_png_base64))
        input_checksum = hashlib.sha256(
            json.dumps(request_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        storage.write_json(job_id, "request.json", request_payload)
        submitted_at = utc_now()
        expires_at = artifact_expiry()
        submission_record = {
            "job_id": job_id,
            "mode": payload.mode,
            "model_version": SETTINGS.model_version,
            "submitted_at": submitted_at,
            "billed_bases": billed_bases,
            "input_sha256": input_checksum,
            "artifacts_expires_at": expires_at,
        }
        storage.write_json(
            job_id,
            "submission.json",
            submission_record,
        )
        callback_payload = {
            "jobId": job_id,
            "status": "queued",
            "mode": payload.mode,
            "modelVersion": SETTINGS.model_version,
            "inputBases": billed_bases,
            "inputSha256": input_checksum,
            "submittedAt": submitted_at,
            "artifactsExpiresAt": expires_at,
        }
        if SETTINGS.job_callback_url and not persist_job_event(callback_payload):
            raise RuntimeError("failed to stage permanent job callback")
        job = queue.enqueue(
            process_job,
            job_id,
            job_id=job_id,
            job_timeout=SETTINGS.job_timeout_seconds,
            result_ttl=max(SETTINGS.result_ttl_seconds, SETTINGS.file_retention_seconds),
            failure_ttl=SETTINGS.failure_ttl_seconds,
            meta={
                "access_token_sha256": token_digest(access_token),
                "model_version": SETTINGS.model_version,
                "mode": payload.mode,
                "input_bases": billed_bases,
                "eta_total_windows": _request_window_count(request_payload),
                "submitted_at": submitted_at,
                "artifacts_expires_at": expires_at,
                "progress": {"stage": "queued", "percent": 0.0},
                "permanent_record": "pending" if SETTINGS.job_callback_url else "disabled",
            },
        )
    except Exception:
        _http_error(503, "QUEUE_UNAVAILABLE", "Prediction could not be queued.")

    return JobCreated(
        job_id=job.id,
        access_token=access_token,
        model_version=SETTINGS.model_version,
        artifacts_expires_at=expires_at,
        queue=_queue_status(connection, job, "queued"),
        status_url=f"/v1/jobs/{job.id}",
    )


@app.get("/v1/jobs/{job_id}", response_model=JobStatus)
def get_job(job_id: str, x_job_token: str | None = Header(default=None, alias="X-Job-Token")):
    try:
        if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
            _http_error(404, "JOB_NOT_FOUND", "Job not found.")
        connection = get_redis_connection()
        job = Job.fetch(job_id, connection=connection)
    except Exception:
        _http_error(404, "JOB_NOT_FOUND", "Job not found.")
    if not token_matches(x_job_token or "", job.meta.get("access_token_sha256")):
        _http_error(404, "JOB_NOT_FOUND", "Job not found.")
    status = _status_name(job)
    result = job.meta.get("result") if status == "succeeded" else None
    error = job.meta.get("error") if status == "failed" else None
    progress = dict(job.meta.get("progress") or {})
    try:
        progress["estimated_remaining_seconds"] = estimate_remaining_seconds(connection, job, status)
    except Exception:
        progress["estimated_remaining_seconds"] = None
    input_bases = job.meta.get("input_bases")
    if not isinstance(input_bases, int):
        try:
            input_bases = int(JobStorage(SETTINGS.data_root).read_json(job_id, "submission.json")["billed_bases"])
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
            input_bases = None
    return JobStatus(
        job_id=job_id,
        status=status,
        mode=job.meta.get("mode"),
        input_bases=input_bases,
        model_version=job.meta.get("model_version"),
        progress=progress or None,
        submitted_at=job.meta.get("submitted_at"),
        started_at=job.meta.get("started_at"),
        ended_at=job.meta.get("ended_at"),
        artifacts_expires_at=job.meta.get("artifacts_expires_at"),
        queue=_queue_status(connection, job, status),
        result=result,
        error=error,
    )


@app.get("/v1/jobs/{job_id}/result")
def download_result(job_id: str, x_job_token: str | None = Header(default=None, alias="X-Job-Token")):
    try:
        if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
            _http_error(404, "JOB_NOT_FOUND", "Job not found.")
        connection = get_redis_connection()
        job = Job.fetch(job_id, connection=connection)
    except Exception:
        _http_error(404, "JOB_NOT_FOUND", "Job not found.")
    if not token_matches(x_job_token or "", job.meta.get("access_token_sha256")):
        _http_error(404, "JOB_NOT_FOUND", "Job not found.")
    if _status_name(job) != "succeeded":
        _http_error(409, "JOB_NOT_COMPLETE", "Result is not ready.")
    result = job.meta.get("result") or {}
    filename = result.get("filename")
    if not isinstance(filename, str) or "/" in filename or "\\" in filename:
        _http_error(500, "RESULT_UNAVAILABLE", "Result metadata is invalid.")
    try:
        result_path = JobStorage(SETTINGS.data_root).job_dir(job_id) / filename
    except ValueError:
        _http_error(404, "JOB_NOT_FOUND", "Job not found.")
    if not result_path.is_file():
        _http_error(503, "RESULT_UNAVAILABLE", "Result file is unavailable.")
    media_type = ARTIFACT_CONTENT_TYPES.get(result_path.suffix, "application/octet-stream")
    return FileResponse(result_path, media_type=media_type, filename=result_path.name)


@app.api_route("/v1/jobs/{job_id}/artifacts/{filename}", methods=["GET", "HEAD"])
def download_artifact(
    job_id: str,
    filename: str,
    request: Request,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
):
    """Serve a completed artifact with HTTP Range support for JBrowse."""
    try:
        if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
            _http_error(404, "JOB_NOT_FOUND", "Job not found.")
        connection = get_redis_connection()
        job = Job.fetch(job_id, connection=connection)
    except Exception:
        _http_error(404, "JOB_NOT_FOUND", "Job not found.")
    if not token_matches(x_job_token or "", job.meta.get("access_token_sha256")):
        _http_error(404, "JOB_NOT_FOUND", "Job not found.")
    if _status_name(job) != "succeeded":
        _http_error(409, "JOB_NOT_COMPLETE", "Result is not ready.")
    result = job.meta.get("result") or {}
    artifacts = result.get("artifacts") or []
    artifact = next((item for item in artifacts if item.get("filename") == filename), None)
    if not isinstance(artifact, dict):
        _http_error(404, "ARTIFACT_NOT_FOUND", "Artifact not found.")
    try:
        path = JobStorage(SETTINGS.data_root).job_dir(job_id) / filename
    except ValueError:
        _http_error(404, "ARTIFACT_NOT_FOUND", "Artifact not found.")
    if not path.is_file() or path.name != filename:
        _http_error(404, "ARTIFACT_NOT_FOUND", "Artifact not found.")
    size = path.stat().st_size
    parsed = _parse_range(request.headers.get("range"), size)
    if parsed == "invalid":
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    start, end = parsed if parsed else (0, size - 1)
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60",
        "Content-Length": str(end - start + 1),
        "Content-Type": str(artifact.get("content_type") or ARTIFACT_CONTENT_TYPES.get(path.suffix, "application/octet-stream")),
        "Content-Disposition": f'inline; filename="{path.name}"',
    }
    if artifact.get("sha256"):
        headers["ETag"] = f'"sha256-{artifact["sha256"]}"'
    if parsed:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    if request.method == "HEAD":
        return Response(status_code=206 if parsed else 200, headers=headers)
    return StreamingResponse(
        _stream_file(path, start, end),
        status_code=206 if parsed else 200,
        headers=headers,
    )
