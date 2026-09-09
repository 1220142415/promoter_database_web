from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from rq import Queue

from .cgr_cache import (
    ACCESSION_RE,
    SHA256_RE,
    ReferenceCgrNotFound,
    cache_dir,
    reference_cache_lock,
    sha256_file,
    validate_reference_cgr,
    write_cache_entry,
    write_uploaded_cgr_entry,
)
from .config import SETTINGS
from .queueing import get_redis_connection
from .validation import InputValidationError, validate_fasta


IMPORT_ID_RE = re.compile(r"[0-9a-f]{32}")
SUPPORTED_CONTENT_TYPES = {
    "image/png",
    "text/x-fasta",
}


class ReferenceCacheError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _decode(value) -> str | None:
    if value is None:
        return None
    return value.decode() if isinstance(value, bytes) else str(value)


def _state_key(import_id: str) -> str:
    return f"rapptor:reference-cache:import:{import_id}"


def _active_key(accession: str, version: str) -> str:
    return f"rapptor:reference-cache:active:{version}:{accession}"


def _validate_accession(accession: str) -> str:
    if not isinstance(accession, str) or not ACCESSION_RE.fullmatch(accession):
        raise ReferenceCacheError("INVALID_ACCESSION", "Reference accession is invalid.")
    return accession


def _load_state(connection, import_id: str) -> dict | None:
    if not IMPORT_ID_RE.fullmatch(import_id):
        return None
    raw = connection.get(_state_key(import_id))
    if raw is None:
        return None
    try:
        state = json.loads(_decode(raw))
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return state if isinstance(state, dict) else None


def _save_state(connection, state: dict) -> None:
    connection.set(
        _state_key(state["import_id"]),
        json.dumps(state, separators=(",", ":")),
        ex=max(SETTINGS.result_ttl_seconds, SETTINGS.failure_ttl_seconds),
    )


def public_import_state(state: dict) -> dict:
    return {
        "import_id": state.get("import_id"),
        "accession": state.get("accession"),
        "status": state.get("status"),
        "cgr_version": state.get("cgr_version"),
        "source_sha256": state.get("source_sha256"),
        "cgr_sha256": state.get("cgr_sha256"),
        "error": state.get("error"),
    }


def _manifest_source_sha256(accession: str) -> str | None:
    try:
        directory = cache_dir(
            accession, root=SETTINGS.cgr_cache_root, version=SETTINGS.cgr_version,
        )
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        value = manifest.get("fastaSha256")
        return value if isinstance(value, str) and SHA256_RE.fullmatch(value) else None
    except (OSError, TypeError, ValueError, json.JSONDecodeError, ReferenceCgrNotFound):
        return None


def cache_status(connection, accession: str) -> dict:
    accession = _validate_accession(accession)
    try:
        entry = validate_reference_cgr(accession)
        return {
            "accession": accession,
            "status": "ready",
            "cgr_version": SETTINGS.cgr_version,
            "source_sha256": entry["fasta_sha256"],
        }
    except ReferenceCgrNotFound:
        pass

    active_id = _decode(connection.get(_active_key(accession, SETTINGS.cgr_version)))
    active = _load_state(connection, active_id) if active_id else None
    if active and active.get("status") == "preparing":
        return {
            "accession": accession,
            "status": "preparing",
            "cgr_version": SETTINGS.cgr_version,
            "source_sha256": active.get("source_sha256"),
        }

    directory = cache_dir(
        accession, root=SETTINGS.cgr_cache_root, version=SETTINGS.cgr_version,
    )
    return {
        "accession": accession,
        "status": "invalid" if directory.exists() else "missing",
        "cgr_version": SETTINGS.cgr_version,
        "source_sha256": _manifest_source_sha256(accession),
    }


def begin_import(
    connection,
    import_id: str,
    accession: str,
    source_sha256: str,
    cgr_sha256: str | None,
    content_type: str,
) -> tuple[dict, bool]:
    accession = _validate_accession(accession)
    source_sha256 = source_sha256.lower()
    if not SHA256_RE.fullmatch(source_sha256):
        raise ReferenceCacheError("INVALID_SOURCE_SHA256", "Source SHA-256 is invalid.")
    content_type = content_type.split(";", 1)[0].strip().lower()
    if content_type not in SUPPORTED_CONTENT_TYPES:
        raise ReferenceCacheError("UNSUPPORTED_SOURCE_FORMAT", "Source format is not supported.")
    cgr_sha256 = cgr_sha256.lower() if content_type == "image/png" and cgr_sha256 else None
    if content_type == "image/png" and (
        cgr_sha256 is None or not SHA256_RE.fullmatch(cgr_sha256)
    ):
        raise ReferenceCacheError("INVALID_CGR_SHA256", "CGR PNG SHA-256 is invalid.")

    try:
        entry = validate_reference_cgr(accession)
    except ReferenceCgrNotFound:
        entry = None
    if entry is not None:
        if entry["fasta_sha256"] != source_sha256:
            raise ReferenceCacheError(
                "REFERENCE_SOURCE_CONFLICT",
                "This accession and CGR version already use a different source.",
            )
        if cgr_sha256 is not None and entry["png_sha256"] != cgr_sha256:
            raise ReferenceCacheError(
                "REFERENCE_CGR_CONFLICT",
                "This accession and CGR version already use a different CGR.",
            )
        return {
            "import_id": None,
            "accession": accession,
            "status": "ready",
            "cgr_version": SETTINGS.cgr_version,
            "source_sha256": source_sha256,
            "cgr_sha256": entry["png_sha256"],
            "error": None,
        }, False

    stored_sha256 = _manifest_source_sha256(accession)
    if stored_sha256 is not None and stored_sha256 != source_sha256:
        raise ReferenceCacheError(
            "REFERENCE_SOURCE_CONFLICT",
            "This accession and CGR version already use a different source.",
        )

    active_key = _active_key(accession, SETTINGS.cgr_version)
    active_id = _decode(connection.get(active_key))
    active = _load_state(connection, active_id) if active_id else None
    if active and active.get("status") == "preparing":
        if (
            active.get("source_sha256") == source_sha256
            and active.get("cgr_sha256") == cgr_sha256
            and active.get("content_type", "image/png") == content_type
        ):
            return active, False
        raise ReferenceCacheError("REFERENCE_IMPORT_BUSY", "A different import is already preparing.")

    state = {
        "import_id": import_id,
        "accession": accession,
        "status": "preparing",
        "cgr_version": SETTINGS.cgr_version,
        "source_sha256": source_sha256,
        "cgr_sha256": cgr_sha256,
        "content_type": content_type,
        "created_at": _now(),
        "error": None,
    }
    _save_state(connection, state)
    reserved = connection.set(
        active_key,
        import_id,
        nx=True,
        ex=max(SETTINGS.job_stall_timeout_seconds, 300),
    )
    if not reserved:
        connection.delete(_state_key(import_id))
        active_id = _decode(connection.get(active_key))
        active = _load_state(connection, active_id) if active_id else None
        if (
            active
            and active.get("source_sha256") == source_sha256
            and active.get("cgr_sha256") == cgr_sha256
            and active.get("content_type", "image/png") == content_type
        ):
            return active, False
        raise ReferenceCacheError("REFERENCE_IMPORT_BUSY", "A different import is already preparing.")

    active_count = sum(
        1 for _ in connection.scan_iter("rapptor:reference-cache:active:*")
    )
    if active_count > SETTINGS.reference_cache_max_pending:
        connection.delete(active_key, _state_key(import_id))
        raise ReferenceCacheError("REFERENCE_IMPORT_BUSY", "Reference import capacity is full.")
    return state, True


def abort_import(connection, state: dict) -> None:
    active_key = _active_key(state["accession"], state["cgr_version"])
    if _decode(connection.get(active_key)) == state["import_id"]:
        connection.delete(active_key)
    connection.delete(_state_key(state["import_id"]))
    shutil.rmtree(import_dir(state["import_id"]), ignore_errors=True)


def import_dir(import_id: str) -> Path:
    if not IMPORT_ID_RE.fullmatch(import_id):
        raise ReferenceCacheError("REFERENCE_IMPORT_NOT_FOUND", "Reference import was not found.")
    root = (SETTINGS.data_root / "reference-cache-imports").resolve()
    directory = (root / import_id).resolve()
    if not directory.is_relative_to(root):
        raise ReferenceCacheError("REFERENCE_IMPORT_NOT_FOUND", "Reference import was not found.")
    return directory


def enqueue_import(connection, import_id: str) -> None:
    Queue(
        SETTINGS.reference_cache_queue_name,
        connection=connection,
        default_timeout=SETTINGS.job_stall_timeout_seconds,
    ).enqueue(
        process_reference_import,
        import_id,
        job_id=f"reference-cache-{import_id}",
        job_timeout=SETTINGS.job_stall_timeout_seconds,
        result_ttl=SETTINGS.result_ttl_seconds,
        failure_ttl=SETTINGS.failure_ttl_seconds,
        on_failure=mark_reference_import_failed,
    )


def _finish(connection, state: dict, *, status: str, error: dict | None = None) -> None:
    state = {**state, "status": status, "error": error, "ended_at": _now()}
    _save_state(connection, state)
    active_key = _active_key(state["accession"], state["cgr_version"])
    if _decode(connection.get(active_key)) == state["import_id"]:
        connection.delete(active_key)


def mark_reference_import_failed(job, connection, *_failure) -> None:
    import_id = job.args[0] if job.args else ""
    state = _load_state(connection, import_id)
    if state is None or state.get("status") != "preparing":
        return
    error = {"code": "REFERENCE_IMPORT_FAILED", "message": "Reference import failed."}
    _finish(connection, state, status="failed", error=error)
    shutil.rmtree(import_dir(import_id), ignore_errors=True)


def process_reference_import(import_id: str) -> dict:
    connection = get_redis_connection()
    state = _load_state(connection, import_id)
    if state is None:
        return {"status": "failed", "error": "REFERENCE_IMPORT_NOT_FOUND"}
    directory = import_dir(import_id)
    upload_path = directory / "upload"
    try:
        if upload_path.stat().st_size > SETTINGS.reference_cache_max_upload_bytes:
            raise ReferenceCacheError(
                "REFERENCE_UPLOAD_TOO_LARGE", "Reference upload is too large."
            )
        with reference_cache_lock(
            state["accession"], root=SETTINGS.cgr_cache_root, version=state["cgr_version"],
        ):
            try:
                entry = validate_reference_cgr(
                    state["accession"], expected_fasta_sha256=state["source_sha256"],
                )
            except ReferenceCgrNotFound:
                entry = None
            if entry is None:
                existing_sha256 = _manifest_source_sha256(state["accession"])
                if existing_sha256 is not None and existing_sha256 != state["source_sha256"]:
                    raise ReferenceCacheError(
                        "REFERENCE_SOURCE_CONFLICT",
                        "This accession and CGR version already use a different source.",
                    )
                if state.get("content_type", "image/png") == "text/x-fasta":
                    if sha256_file(upload_path) != state["source_sha256"]:
                        raise ReferenceCacheError(
                            "REFERENCE_SOURCE_CHECKSUM_MISMATCH", "FASTA SHA-256 does not match."
                        )
                    try:
                        validate_fasta(
                            upload_path.read_text(encoding="utf-8"),
                            max_bases=SETTINGS.max_genome_bases,
                            max_ambiguous_fraction=SETTINGS.max_ambiguous_fraction,
                        )
                        entry = write_cache_entry(
                            state["accession"],
                            upload_path,
                            state["source_sha256"],
                            root=SETTINGS.cgr_cache_root,
                            version=state["cgr_version"],
                        )
                    except (OSError, UnicodeError, InputValidationError, ValueError) as exc:
                        raise ReferenceCacheError(
                            "REFERENCE_FASTA_INVALID", "Uploaded FASTA is invalid."
                        ) from exc
                else:
                    try:
                        entry = write_uploaded_cgr_entry(
                            state["accession"],
                            upload_path,
                            state["source_sha256"],
                            state["cgr_sha256"],
                            root=SETTINGS.cgr_cache_root,
                            version=state["cgr_version"],
                        )
                    except (OSError, ValueError) as exc:
                        code = (
                            "REFERENCE_CGR_CHECKSUM_MISMATCH"
                            if "SHA-256" in str(exc)
                            else "REFERENCE_CGR_INVALID"
                        )
                        raise ReferenceCacheError(code, "Uploaded CGR PNG is invalid.") from exc
            elif state["cgr_sha256"] is not None and entry["png_sha256"] != state["cgr_sha256"]:
                raise ReferenceCacheError(
                    "REFERENCE_CGR_CONFLICT",
                    "This accession and CGR version already use a different CGR.",
                )
        state["cgr_sha256"] = entry["png_sha256"]
        _finish(connection, state, status="ready")
        return {"status": "ready", "png_sha256": entry["png_sha256"]}
    except ReferenceCacheError as exc:
        _finish(connection, state, status="failed", error={"code": exc.code, "message": exc.message})
        return {"status": "failed", "error": exc.code}
    except Exception:
        error = {"code": "REFERENCE_IMPORT_FAILED", "message": "Reference import failed."}
        _finish(connection, state, status="failed", error=error)
        return {"status": "failed", "error": error["code"]}
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def get_import_state(connection, import_id: str) -> dict:
    state = _load_state(connection, import_id)
    if state is None:
        raise ReferenceCacheError("REFERENCE_IMPORT_NOT_FOUND", "Reference import was not found.")
    return state
