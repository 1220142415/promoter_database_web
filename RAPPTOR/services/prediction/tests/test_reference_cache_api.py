import asyncio
import hashlib
import importlib
import json
from io import BytesIO

import fakeredis
import pytest
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError
from starlette.requests import Request


ACCESSION = "GCF_000005845.1"
VERSION = "cgr-128-v1"
SECRET = "cache-service-secret"
SOURCE_SHA256 = "a" * 64


def png_bytes(color=127, size=(128, 128)):
    output = BytesIO()
    Image.new("L", size, color=color).save(output, format="PNG")
    return output.getvalue()


def load_cache_api(tmp_path, monkeypatch, *, max_upload=4096, max_pending=10):
    monkeypatch.setenv("RAPPTOR_DATA_ROOT", str(tmp_path / "data"))
    monkeypatch.setenv("RAPPTOR_CGR_CACHE_ROOT", str(tmp_path / "cache"))
    monkeypatch.setenv("RAPPTOR_CGR_VERSION", VERSION)
    monkeypatch.setenv("RAPPTOR_MODEL_DIR", str(tmp_path / "models"))
    monkeypatch.setenv("RAPPTOR_TICKET_VALIDATION_MODE", "disabled")
    monkeypatch.setenv("RAPPTOR_TICKET_SERVICE_SECRET", SECRET)
    monkeypatch.setenv("RAPPTOR_REQUIRE_WORKER_FOR_READY", "false")
    monkeypatch.setenv("RAPPTOR_REFERENCE_CACHE_MAX_UPLOAD_BYTES", str(max_upload))
    monkeypatch.setenv("RAPPTOR_REFERENCE_CACHE_MAX_PENDING", str(max_pending))
    import prediction_service.config as config
    import prediction_service.cgr_cache as cgr_cache
    import prediction_service.queueing as queueing
    import prediction_service.reference_cache as reference_cache
    import prediction_service.tickets as tickets
    import prediction_service.api as api

    importlib.reload(config)
    importlib.reload(cgr_cache)
    importlib.reload(queueing)
    importlib.reload(reference_cache)
    importlib.reload(tickets)
    importlib.reload(api)
    connection = fakeredis.FakeRedis()
    monkeypatch.setattr(api, "get_redis_connection", lambda: connection)
    monkeypatch.setattr(reference_cache, "get_redis_connection", lambda: connection)
    return api, reference_cache, cgr_cache, connection


def request(body: bytes, content_type="image/png") -> Request:
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [
            (b"content-type", content_type.encode()),
            (b"content-length", str(len(body)).encode()),
        ],
    }, receive)


def response_json(response):
    return json.loads(response.body) if hasattr(response, "body") else response


def submit(api, monkeypatch, accession, body, *, source_sha256=SOURCE_SHA256, content_type="image/png"):
    queued = []
    monkeypatch.setattr(api, "enqueue_import", lambda connection, import_id: queued.append(import_id))
    response = asyncio.run(api.import_reference_cache(
        accession,
        request(body, content_type),
        authorization=f"Bearer {SECRET}",
        x_source_sha256=source_sha256,
        x_cgr_sha256=hashlib.sha256(body).hexdigest() if content_type == "image/png" else None,
        x_cgr_version=VERSION,
    ))
    return response_json(response), queued


def test_cache_query_requires_service_secret(tmp_path, monkeypatch):
    api, _, _, _ = load_cache_api(tmp_path, monkeypatch)
    for authorization in (None, "Bearer wrong"):
        with pytest.raises(HTTPException) as denied:
            api.get_reference_cache(ACCESSION, authorization)
        assert denied.value.status_code == 401
        assert denied.value.detail["code"] == "UNAUTHORIZED"


def test_query_distinguishes_ready_missing_preparing_and_invalid(tmp_path, monkeypatch):
    api, reference_cache, cgr_cache, connection = load_cache_api(tmp_path, monkeypatch)
    body = png_bytes()
    cgr_sha256 = hashlib.sha256(body).hexdigest()
    assert api.get_reference_cache(ACCESSION, f"Bearer {SECRET}")["status"] == "missing"
    state, created = reference_cache.begin_import(
        connection, "1" * 32, ACCESSION, SOURCE_SHA256, cgr_sha256, "image/png",
    )
    assert created is True
    assert api.get_reference_cache(ACCESSION, f"Bearer {SECRET}")["status"] == "preparing"
    reference_cache.abort_import(connection, state)

    directory = cgr_cache.cache_dir(ACCESSION, root=api.SETTINGS.cgr_cache_root, version=VERSION)
    directory.mkdir(parents=True)
    (directory / "manifest.json").write_text("{}")
    assert api.get_reference_cache(ACCESSION, f"Bearer {SECRET}")["status"] == "invalid"

    payload, queued = submit(api, monkeypatch, ACCESSION, body)
    assert payload["status"] == "preparing"
    assert reference_cache.process_reference_import(queued[0])["status"] == "ready"
    assert api.get_reference_cache(ACCESSION, f"Bearer {SECRET}") == {
        "accession": ACCESSION,
        "status": "ready",
        "cgr_version": VERSION,
        "source_sha256": SOURCE_SHA256,
    }


def test_batch_query_is_bounded(tmp_path, monkeypatch):
    api, _, _, _ = load_cache_api(tmp_path, monkeypatch)
    result = api.query_reference_cache(
        api.ReferenceCacheQuery(accessions=[ACCESSION, "GCF_000005845.2"]),
        f"Bearer {SECRET}",
    )
    assert [entry["status"] for entry in result["entries"]] == ["missing", "missing"]
    with pytest.raises(ValidationError):
        api.ReferenceCacheQuery(accessions=[ACCESSION] * 101)


def test_png_import_is_async_loadable_and_idempotent(tmp_path, monkeypatch):
    api, reference_cache, _, _ = load_cache_api(tmp_path, monkeypatch)
    body = png_bytes()
    first, queued = submit(api, monkeypatch, ACCESSION, body)
    assert first["status"] == "preparing"
    assert first["import_id"] == queued[0]
    assert first["cgr_sha256"] == hashlib.sha256(body).hexdigest()
    assert reference_cache.process_reference_import(queued[0])["status"] == "ready"
    assert not reference_cache.import_dir(queued[0]).exists()

    second, second_queued = submit(api, monkeypatch, ACCESSION, body)
    assert second["status"] == "ready"
    assert second["import_id"] is None
    assert second_queued == []


def test_fasta_import_generates_cgr_and_accepts_gca(tmp_path, monkeypatch):
    api, reference_cache, cgr_cache, connection = load_cache_api(tmp_path, monkeypatch)
    accession = "GCA_000005845.1"
    body = (">synthetic\n" + "ACGT" * 100 + "\n").encode()
    source_sha256 = hashlib.sha256(body).hexdigest()

    first, queued = submit(
        api, monkeypatch, accession, body,
        source_sha256=source_sha256, content_type="text/x-fasta; charset=utf-8",
    )
    assert first["status"] == "preparing"
    assert first["cgr_sha256"] is None
    assert reference_cache.process_reference_import(queued[0])["status"] == "ready"
    ready = reference_cache.public_import_state(
        reference_cache.get_import_state(connection, queued[0])
    )
    assert ready["status"] == "ready"
    assert ready["cgr_sha256"] == cgr_cache.sha256_file(
        cgr_cache.cache_dir(accession, root=api.SETTINGS.cgr_cache_root, version=VERSION) / "cgr.png"
    )

    second, second_queued = submit(
        api, monkeypatch, accession, body,
        source_sha256=source_sha256, content_type="text/x-fasta",
    )
    assert second["status"] == "ready"
    assert second["cgr_sha256"] == ready["cgr_sha256"]
    assert second_queued == []


@pytest.mark.parametrize("body", [b"ACGT", b">empty\n", b">bad\nACGX\n", b"\xff"])
def test_fasta_import_rejects_invalid_records_and_cleans_upload(tmp_path, monkeypatch, body):
    api, reference_cache, cgr_cache, connection = load_cache_api(tmp_path, monkeypatch)
    source_sha256 = hashlib.sha256(body).hexdigest()
    _, queued = submit(
        api, monkeypatch, ACCESSION, body,
        source_sha256=source_sha256, content_type="text/x-fasta",
    )
    assert reference_cache.process_reference_import(queued[0]) == {
        "status": "failed", "error": "REFERENCE_FASTA_INVALID",
    }
    assert reference_cache.get_import_state(connection, queued[0])["status"] == "failed"
    assert not reference_cache.import_dir(queued[0]).exists()
    assert not cgr_cache.cache_dir(
        ACCESSION, root=api.SETTINGS.cgr_cache_root, version=VERSION,
    ).exists()


def test_fasta_import_requires_exact_source_hash(tmp_path, monkeypatch):
    api, _, _, _ = load_cache_api(tmp_path, monkeypatch)
    body = b">synthetic\nACGTACGTACGT\n"
    with pytest.raises(HTTPException) as mismatch:
        submit(
            api, monkeypatch, ACCESSION, body,
            source_sha256="b" * 64, content_type="text/x-fasta",
        )
    assert mismatch.value.detail["code"] == "REFERENCE_SOURCE_CHECKSUM_MISMATCH"


def test_accession_versions_are_isolated_and_hash_conflicts_are_rejected(tmp_path, monkeypatch):
    api, reference_cache, _, _ = load_cache_api(tmp_path, monkeypatch)
    for accession, source, body in (
        (ACCESSION, "a" * 64, png_bytes(10)),
        ("GCF_000005845.2", "b" * 64, png_bytes(20)),
    ):
        _, queued = submit(api, monkeypatch, accession, body, source_sha256=source)
        assert reference_cache.process_reference_import(queued[0])["status"] == "ready"
    assert api.get_reference_cache(ACCESSION, f"Bearer {SECRET}")["source_sha256"] == "a" * 64
    assert api.get_reference_cache("GCF_000005845.2", f"Bearer {SECRET}")["source_sha256"] == "b" * 64

    with pytest.raises(HTTPException) as source_conflict:
        submit(api, monkeypatch, ACCESSION, png_bytes(10), source_sha256="c" * 64)
    assert source_conflict.value.detail["code"] == "REFERENCE_SOURCE_CONFLICT"
    with pytest.raises(HTTPException) as cgr_conflict:
        submit(api, monkeypatch, ACCESSION, png_bytes(30), source_sha256="a" * 64)
    assert cgr_conflict.value.detail["code"] == "REFERENCE_CGR_CONFLICT"


def test_checksum_invalid_png_and_size_failures_leave_no_partial_cache(tmp_path, monkeypatch):
    api, reference_cache, cgr_cache, connection = load_cache_api(tmp_path, monkeypatch, max_upload=1024)
    body = png_bytes()
    with pytest.raises(HTTPException) as mismatch:
        asyncio.run(api.import_reference_cache(
            ACCESSION,
            request(body),
            authorization=f"Bearer {SECRET}",
            x_source_sha256=SOURCE_SHA256,
            x_cgr_sha256="b" * 64,
            x_cgr_version=VERSION,
        ))
    assert mismatch.value.detail["code"] == "REFERENCE_CGR_CHECKSUM_MISMATCH"

    invalid, queued = submit(api, monkeypatch, ACCESSION, b"not-a-png")
    assert invalid["status"] == "preparing"
    assert reference_cache.process_reference_import(queued[0]) == {
        "status": "failed", "error": "REFERENCE_CGR_INVALID",
    }
    assert reference_cache.get_import_state(connection, queued[0])["status"] == "failed"
    assert not cgr_cache.cache_dir(ACCESSION, root=api.SETTINGS.cgr_cache_root, version=VERSION).exists()

    oversized = b"x" * 1025
    with pytest.raises(HTTPException) as too_large:
        submit(api, monkeypatch, ACCESSION, oversized)
    assert too_large.value.detail["code"] == "REFERENCE_UPLOAD_TOO_LARGE"


def test_concurrent_same_cgr_reuses_import_and_pending_limit_is_enforced(tmp_path, monkeypatch):
    _, reference_cache, _, connection = load_cache_api(tmp_path, monkeypatch, max_pending=1)
    cgr_sha256 = hashlib.sha256(png_bytes()).hexdigest()
    first, created = reference_cache.begin_import(
        connection, "1" * 32, ACCESSION, SOURCE_SHA256, cgr_sha256, "image/png",
    )
    duplicate, duplicate_created = reference_cache.begin_import(
        connection, "2" * 32, ACCESSION, SOURCE_SHA256, cgr_sha256, "image/png",
    )
    assert created is True
    assert duplicate_created is False
    assert duplicate["import_id"] == first["import_id"]
    with pytest.raises(reference_cache.ReferenceCacheError) as busy:
        reference_cache.begin_import(
            connection, "3" * 32, "GCF_000005845.2", "b" * 64, cgr_sha256, "image/png",
        )
    assert busy.value.code == "REFERENCE_IMPORT_BUSY"


def test_failed_publish_preserves_existing_cache_and_rq_failure_cleans_upload(tmp_path, monkeypatch):
    api, reference_cache, cgr_cache, connection = load_cache_api(tmp_path, monkeypatch)
    body = png_bytes()
    directory = cgr_cache.cache_dir(ACCESSION, root=api.SETTINGS.cgr_cache_root, version=VERSION)
    directory.mkdir(parents=True)
    marker = directory / "keep-me"
    marker.write_text("original")
    (directory / "manifest.json").write_text(json.dumps({"fastaSha256": SOURCE_SHA256}))
    monkeypatch.setattr(
        reference_cache,
        "write_uploaded_cgr_entry",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    _, queued = submit(api, monkeypatch, ACCESSION, body)
    assert reference_cache.process_reference_import(queued[0])["error"] == "REFERENCE_IMPORT_FAILED"
    assert marker.read_text() == "original"
    assert not reference_cache.import_dir(queued[0]).exists()

    state, _ = reference_cache.begin_import(
        connection, "1" * 32, "GCF_000005845.2", SOURCE_SHA256,
        hashlib.sha256(body).hexdigest(), "image/png",
    )
    upload = reference_cache.import_dir(state["import_id"])
    upload.mkdir(parents=True)
    (upload / "upload").write_bytes(body)
    job = type("Job", (), {"args": (state["import_id"],)})()
    reference_cache.mark_reference_import_failed(job, connection, RuntimeError, RuntimeError(), None)
    assert reference_cache.get_import_state(connection, state["import_id"])["status"] == "failed"
    assert not upload.exists()
