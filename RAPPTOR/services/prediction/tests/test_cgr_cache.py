import hashlib
import json
from datetime import datetime, timezone
from dataclasses import replace

import numpy as np
import pytest
import torch
from PIL import Image

from prediction_service import jobs
from prediction_service.build_cgr_cache import build_cache
from prediction_service import cgr_cache
from prediction_service.cgr_cache import load_reference_cgr
from prediction_service.config import SETTINGS
from prediction_service.storage import JobStorage


ACCESSION = "GCF_000005845.1"
VERSION = "cgr-128-v1"


def _write_source(root):
    source = root / "source"
    fasta_dir = source / ACCESSION
    fasta_dir.mkdir(parents=True)
    fasta = fasta_dir / "reference.fasta"
    fasta.write_text(">genome\n" + "ACGT" * 100 + "\n")
    digest = hashlib.sha256(fasta.read_bytes()).hexdigest()
    (source / "genomes.tsv").write_text("gcf\n" + ACCESSION + "\n")
    (source / "source-checksums.sha256").write_text(f"{digest}  genome_sequences/{ACCESSION}.fna\n")
    return source


def test_cache_builder_is_repeatable_and_loadable(tmp_path):
    source = _write_source(tmp_path)
    cache = tmp_path / "cache"
    first = build_cache(source, cache, VERSION, expected_count=1)
    second = build_cache(source, cache, VERSION, expected_count=1)
    assert (first["generated"], first["skipped"], first["failed"]) == (1, 0, 0)
    assert (second["generated"], second["skipped"], second["failed"]) == (0, 1, 0)
    assert load_reference_cgr(ACCESSION, root=cache, version=VERSION).shape == (1, 128, 128)
    assert not list(cache.rglob("*.npy"))


def test_missing_cache_uses_only_trusted_worker_source(tmp_path, monkeypatch):
    fasta = (">genome\n" + "ACGT" * 100 + "\n").encode()
    source = {"url": "https://huggingface.co/example/reference.fna", "sha256": hashlib.sha256(fasta).hexdigest()}
    monkeypatch.setattr(cgr_cache, "SETTINGS", replace(
        SETTINGS,
        cgr_cache_root=tmp_path / "cache",
        cgr_version=VERSION,
        max_request_bytes=1024 * 1024,
        max_genome_bases=1000,
    ))

    def fake_download(provided_source, destination):
        assert provided_source == source
        destination.write_bytes(fasta)

    monkeypatch.setattr(cgr_cache, "_download_reference_fasta", fake_download)
    tensor = cgr_cache.ensure_reference_cgr(ACCESSION, source)
    assert tensor.shape == (1, 128, 128)
    assert cgr_cache.ensure_reference_cgr(ACCESSION).shape == (1, 128, 128)


def test_reference_tensor_is_reused_and_invalidated_by_png_hash(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    directory = cache / ACCESSION / VERSION
    directory.mkdir(parents=True)

    def write_entry(color):
        png = directory / "cgr.png"
        Image.new("L", (128, 128), color=color).save(png)
        (directory / "manifest.json").write_text(json.dumps({
            "accession": ACCESSION,
            "fastaSha256": "a" * 64,
            "cgrPngSha256": hashlib.sha256(png.read_bytes()).hexdigest(),
            "resolution": 128,
            "cgrVersion": VERSION,
            "generatedAt": "2026-09-09T00:00:00Z",
        }))

    monkeypatch.setattr(cgr_cache, "SETTINGS", replace(
        SETTINGS, cgr_cache_root=cache, cgr_version=VERSION,
    ))
    cgr_cache._cached_reference_tensor.cache_clear()
    write_entry(32)
    first, first_status = cgr_cache.get_reference_cgr_tensor(ACCESSION)
    second, second_status = cgr_cache.get_reference_cgr_tensor(ACCESSION)
    write_entry(224)
    changed, changed_status = cgr_cache.get_reference_cgr_tensor(ACCESSION)

    assert first_status == "disk_hit"
    assert second_status == "memory_hit"
    assert second is first
    assert changed_status == "disk_hit"
    assert changed is not first
    assert not torch.equal(changed, first)
    assert cgr_cache._cached_reference_tensor.cache_info().maxsize == 128


def test_worker_source_rejects_non_https_url():
    source = {"url": "file:///etc/passwd", "sha256": "a" * 64}
    try:
        cgr_cache.normalize_reference_source(ACCESSION, source)
    except cgr_cache.ReferenceCgrNotFound as exc:
        assert str(exc) == "Reference CGR is unavailable."
    else:
        raise AssertionError("unsafe source URL was accepted")


class FakeRuntime:
    seq_length = 100
    upstream_len = 50
    device = torch.device("cpu")
    checkpoint_sha256 = "b" * 64
    model_config_sha256 = "c" * 64

    def __init__(self):
        self.scored_sequences = []

    def score_sequence(self, sequence, cgr, *, stride, batch_size, progress_callback=None):
        assert cgr.shape == (1, 128, 128)
        self.scored_sequences.append(sequence)
        count = (len(sequence) - self.seq_length) // stride + 1
        offset = 1000 if len(self.scored_sequences) == 2 else 0
        if progress_callback is not None:
            progress_callback(count, count)
        return np.arange(count, dtype=np.float32) + offset

    def reverse_complement(self, sequence):
        return sequence.translate(str.maketrans("ACGTN", "TGCAN"))[::-1]

    def make_cgr(self, fasta_path, job_dir):
        assert fasta_path.name == "genome_context.fasta"
        return torch.zeros((1, 128, 128))

    def metadata(self):
        return {"model_version": "test"}


def _predict_with_context(tmp_path, monkeypatch, sequence, *, reverse_complementary):
    runtime = FakeRuntime()
    monkeypatch.setattr(jobs, "get_runtime", lambda: runtime)
    storage = JobStorage(tmp_path / "data")
    job_id = "4" * 32
    storage.create(job_id)
    jobs._predict(job_id, {
        "sequence": sequence,
        "genome_context": "ACGT" * 100,
        "cgr_source": "complete_genome_sequence",
        "batch_size": 32,
        "reverse_complementary": reverse_complementary,
    }, storage)
    rows = storage.read_json(job_id, "scores.json")
    summary = storage.read_json(job_id, "summary.json")
    return runtime, rows, summary


def test_predict_100bp_writes_one_window_per_strand(tmp_path, monkeypatch):
    sequence = "A" * 99 + "C"
    runtime, rows, summary = _predict_with_context(
        tmp_path, monkeypatch, sequence, reverse_complementary=True
    )
    assert [row["strand"] for row in rows] == ["+", "-"]
    assert [row["window_start_0based"] for row in rows] == [0, 0]
    assert [row["anchor_position_0based"] for row in rows] == [50, 49]
    assert summary["window_count"] == 2
    assert summary["reverse_complementary"] is True
    assert runtime.scored_sequences == [sequence, runtime.reverse_complement(sequence)]


def test_predict_rejects_non_100bp_sequence_in_worker(tmp_path, monkeypatch):
    with pytest.raises(ValueError, match="at most 100"):
        _predict_with_context(
            tmp_path, monkeypatch, "A" * 101, reverse_complementary=True
        )


def test_predict_100bp_can_disable_reverse_complement(tmp_path, monkeypatch):
    sequence = "A" * 99 + "C"
    runtime, rows, summary = _predict_with_context(
        tmp_path, monkeypatch, sequence, reverse_complementary=False
    )
    assert len(rows) == 1
    assert {row["strand"] for row in rows} == {"+"}
    assert {row["window_start_0based"] for row in rows} == {0}
    assert summary["window_count"] == 1
    assert summary["reverse_complementary"] is False
    assert runtime.scored_sequences == [sequence]


def test_reference_accession_completes_predict_without_fasta(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    directory = cache / ACCESSION / VERSION
    directory.mkdir(parents=True)
    png = directory / "cgr.png"
    Image.new("L", (128, 128), color=127).save(png)
    (directory / "manifest.json").write_text(json.dumps({
        "accession": ACCESSION,
        "fastaSha256": "a" * 64,
        "cgrPngSha256": hashlib.sha256(png.read_bytes()).hexdigest(),
        "resolution": 128,
        "cgrVersion": VERSION,
        "generatedAt": "2026-09-07T00:00:00Z",
    }))
    monkeypatch.setattr(jobs, "get_runtime", lambda: FakeRuntime())
    monkeypatch.setattr(
        jobs,
        "get_reference_cgr_tensor",
        lambda accession, source=None, device="cpu": (
            load_reference_cgr(accession, root=cache, version=VERSION).to(device), "disk_hit",
        ),
    )
    storage = JobStorage(tmp_path / "data")
    job_id = "1" * 32
    storage.create(job_id)
    result = jobs._predict(job_id, {
        "sequence": "A" * 100,
        "reference_accession": ACCESSION,
        "cgr_source": "reference_accession",
        "batch_size": 1,
    }, storage)
    summary = storage.read_json(job_id, "summary.json")
    assert result["format"] == "json"
    assert summary["reference_accession"] == ACCESSION
    assert summary["cgr_source"] == "reference_accession"
    assert not (storage.job_dir(job_id) / "genome_context.fasta").exists()

    context_job_id = "2" * 32
    storage.create(context_job_id)
    jobs._predict(context_job_id, {
        "sequence": "A" * 100,
        "genome_context": "ACGT" * 100,
        "cgr_source": "complete_genome_sequence",
        "batch_size": 1,
    }, storage)
    context_summary = storage.read_json(context_job_id, "summary.json")
    assert context_summary["cgr_source"] == "complete_genome_sequence"
    assert (storage.job_dir(context_job_id) / "genome_context.fasta").is_file()

    fasta_job_id = "3" * 32
    storage.create(fasta_job_id)
    jobs._predict(fasta_job_id, {
        "sequence": "A" * 100,
        "fasta": ">one\n" + "ACGT" * 100,
        "cgr_source": "uploaded_complete_genome_fasta",
        "batch_size": 1,
    }, storage)
    fasta_summary = storage.read_json(fasta_job_id, "summary.json")
    assert fasta_summary["cgr_source"] == "uploaded_complete_genome_fasta"
    assert fasta_summary["genome_context_bases"] == 400


def test_predict_emits_only_non_sensitive_stage_timings(tmp_path, monkeypatch, capsys):
    data_root = tmp_path / "data"
    monkeypatch.setattr(jobs, "SETTINGS", replace(
        SETTINGS, data_root=data_root, job_callback_url=None, job_callback_secret=None,
    ))
    monkeypatch.setattr(jobs, "get_runtime", lambda: FakeRuntime())
    storage = JobStorage(data_root)
    job_id = "5" * 32
    storage.create(job_id)
    storage.write_json(job_id, "request.json", {
        "mode": "predict",
        "sequence": "A" * 100,
        "genome_context": "ACGT" * 100,
        "cgr_source": "complete_genome_sequence",
        "batch_size": 1,
        "reverse_complementary": True,
    })
    storage.write_json(job_id, "submission.json", {
        "job_id": job_id,
        "mode": "predict",
        "model_version": "test",
        "billed_bases": 100,
        "input_sha256": "a" * 64,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "artifacts_expires_at": None,
    })

    jobs.process_job(job_id)

    timing = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert set(timing) == {
        "event", "queue_wait_ms", "model_load_ms", "cgr_load_ms",
        "inference_ms", "output_ms", "total_ms", "cgr_cache",
    }
    assert timing["event"] == "prediction_timing"
    assert timing["cgr_cache"] == "miss"
    assert all(timing[field] >= 0 for field in (
        "queue_wait_ms", "model_load_ms", "cgr_load_ms", "inference_ms", "output_ms", "total_ms",
    ))
    assert "sequence" not in timing and "ticket" not in timing and "token" not in timing
