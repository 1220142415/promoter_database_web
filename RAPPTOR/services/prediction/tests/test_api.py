import asyncio
import importlib
from starlette.requests import Request

import fakeredis
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from rq import Queue


def load_api(tmp_path, monkeypatch):
    monkeypatch.setenv("RAPPTOR_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("RAPPTOR_MODEL_DIR", str(tmp_path / "models"))
    monkeypatch.setenv("RAPPTOR_TICKET_VALIDATION_MODE", "disabled")
    monkeypatch.setenv("RAPPTOR_REQUIRE_WORKER_FOR_READY", "false")
    monkeypatch.setenv("RAPPTOR_MIN_SCAN_STRIDE", "1")
    monkeypatch.setenv("RAPPTOR_FILE_RETENTION_SECONDS", "86400")
    import prediction_service.config as config
    import prediction_service.queueing as queueing
    import prediction_service.tickets as tickets
    import prediction_service.api as api
    importlib.reload(config)
    importlib.reload(queueing)
    importlib.reload(tickets)
    importlib.reload(api)
    connection = fakeredis.FakeRedis()
    monkeypatch.setattr(api, "get_redis_connection", lambda: connection)
    monkeypatch.setattr(api, "get_queue", lambda connection=None: Queue("prediction", connection=connection, is_async=True))
    return api, connection


def test_healthz(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    assert api.healthz() == {"status": "ok"}
    assert api.readyz()["status"] == "ready"
    assert api.current_model()["requires_complete_genome"] is True


def test_predict_requires_genome_context(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    with pytest.raises(ValidationError, match="complete genome"):
        api.JobSubmission(mode="predict", complete_genome=True, sequence="A" * 100)


def test_genome_scan_accepts_stride_one(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    payload = api.JobSubmission(
        mode="genome_scan",
        complete_genome=True,
        fasta=">contig\n" + "ACGT" * 100,
        stride=1,
        score_cutoff=0.9,
        output_formats=["bigwig", "gff3"],
    )
    request, _ = api._validate_submission(payload)
    assert request["stride"] == 1
    assert request["score_cutoff"] == 0.9
    assert request["output_formats"] == ["bigwig", "gff3"]
    capabilities = api.current_model()["genome_scan"]
    assert capabilities["score_cutoff"]["operator"] == ">"
    assert capabilities["score_cutoff"]["applies_to"] == ["gff3", "json"]
    assert capabilities["reverse_complementary"]["default"] is True
    assert "top_k" in capabilities["unsupported_filters"]


def test_submit_and_token_protected_status(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    created = asyncio.run(api.submit_job(
        api.JobSubmission(
            mode="genome_scan",
            complete_genome=True,
            fasta=">contig\n" + "ACGT" * 100,
            stride=50,
        ),
        authorization=None,
    ))
    job_id = created.job_id
    token = created.access_token
    assert (tmp_path / "jobs" / job_id / "request.json").is_file()
    with pytest.raises(HTTPException) as hidden:
        api.get_job(job_id, None)
    assert hidden.value.status_code == 404
    status = api.get_job(job_id, token)
    assert status.status == "queued"
    assert status.artifacts_expires_at == created.artifacts_expires_at
    assert status.artifacts_expires_at is not None


def test_result_requires_completed_job(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    created = asyncio.run(api.submit_job(
        api.JobSubmission(
            mode="genome_scan",
            complete_genome=True,
            fasta=">contig\n" + "ACGT" * 100,
            stride=50,
        ),
        authorization=None,
    ))
    with pytest.raises(HTTPException) as incomplete:
        api.download_result(created.job_id, created.access_token)
    assert incomplete.value.status_code == 409


def test_artifact_range_is_token_protected(tmp_path, monkeypatch):
    api, connection = load_api(tmp_path, monkeypatch)
    created = asyncio.run(api.submit_job(
        api.JobSubmission(
            mode="genome_scan",
            complete_genome=True,
            fasta=">contig\n" + "ACGT" * 100,
            output_formats=["json"],
        ),
        authorization=None,
    ))
    artifact = tmp_path / "jobs" / created.job_id / "scores.json"
    artifact.write_bytes(b"0123456789")
    job = api.Job.fetch(created.job_id, connection=connection)
    job.meta["result"] = {
        "artifacts": [{
            "filename": "scores.json",
            "format": "json",
            "content_type": "application/json",
            "sha256": "test",
        }],
    }
    job.save_meta()
    monkeypatch.setattr(api, "_status_name", lambda _job: "succeeded")
    scope = {"type": "http", "method": "GET", "path": "/", "headers": [(b"range", b"bytes=2-5")]}
    response = api.download_artifact(created.job_id, "scores.json", Request(scope), created.access_token)
    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert b"".join(api._stream_file(artifact, 2, 5)) == b"2345"
