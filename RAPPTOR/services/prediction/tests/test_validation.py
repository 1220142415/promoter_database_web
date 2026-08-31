import hashlib
import json
from dataclasses import replace

import numpy as np
import pytest
from PIL import Image

from prediction_service.cgr import load_cgr_tensor
from prediction_service.config import SETTINGS
from prediction_service.runtime import validate_model_assets
from prediction_service.schemas import JobSubmission
from prediction_service.validation import InputValidationError, validate_fasta, validate_sequence


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("max_request_bytes", 0),
        ("max_ambiguous_fraction", 1.1),
        ("default_batch_size", SETTINGS.max_batch_size + 1),
        ("worker_heartbeat_interval", SETTINGS.worker_heartbeat_ttl),
        ("ticket_validation_mode", "unknown"),
    ],
)
def test_invalid_service_settings_fail_fast(field, value):
    with pytest.raises(ValueError):
        replace(SETTINGS, **{field: value})


def test_job_callback_requires_url_and_secret_together():
    with pytest.raises(ValueError, match="callback"):
        replace(SETTINGS, job_callback_url="https://example.test/callback", job_callback_secret=None)


def test_sequence_normalizes_iupac_to_n():
    seq = validate_sequence("ACGTry", label="x", min_bases=1, max_bases=100, max_ambiguous_fraction=0.5)
    assert seq == "ACGTNN"


def test_sequence_rejects_invalid_character():
    with pytest.raises(InputValidationError):
        validate_sequence("ACGT;DROP", label="x", min_bases=1, max_bases=100, max_ambiguous_fraction=1.0)


def test_fasta_rejects_duplicate_ids():
    with pytest.raises(InputValidationError, match="duplicate"):
        validate_fasta(">a\nACGT\n>a\nACGT\n", max_bases=100, max_ambiguous_fraction=1.0)


def test_fasta_rejects_unsafe_id():
    with pytest.raises(InputValidationError, match="unsafe"):
        validate_fasta(">../../x\nACGT\n", max_bases=100, max_ambiguous_fraction=1.0)


def test_fasta_counts_bases():
    result = validate_fasta(">a\nACGT\n>b\nNNAA\n", max_bases=100, max_ambiguous_fraction=0.5)
    assert result.total_bases == 8
    assert result.ambiguous_bases == 2
    assert ">a" in result.to_fasta()


def test_job_submission_requires_complete_genome_assertion():
    with pytest.raises(ValueError):
        JobSubmission(mode="genome_scan", fasta=">contig\nACGT")
    submission = JobSubmission(mode="genome_scan", complete_genome=True, fasta=">contig\nACGT")
    assert submission.complete_genome is True


def test_scan_rejects_removed_cutoff_and_top_k_fields():
    with pytest.raises(ValueError):
        JobSubmission(
            mode="genome_scan",
            complete_genome=True,
            fasta=">contig\n" + "ACGT" * 30,
            score_cutoff=0.5,
        )
    with pytest.raises(ValueError):
        JobSubmission(
            mode="genome_scan",
            complete_genome=True,
            fasta=">contig\n" + "ACGT" * 30,
            top_k=10,
        )


def test_cgr_loader_matches_checkpoint_preprocessing(tmp_path):
    path = tmp_path / "cgr.png"
    Image.fromarray(np.full((128, 128), 128, dtype=np.uint8)).save(path)
    tensor = load_cgr_tensor(path)
    expected = (np.log1p(128 / 255) - 0.5) / 0.5
    assert tuple(tensor.shape) == (1, 128, 128)
    assert float(tensor[0, 0, 0]) == pytest.approx(expected)


def test_model_assets_must_match_their_manifest(tmp_path):
    checkpoint = tmp_path / "best_model.pt"
    config = tmp_path / "model_config.json"
    checkpoint.write_bytes(b"checkpoint")
    config.write_text("{}\n", encoding="utf-8")
    manifest = {
        "status": "test",
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "model_config_sha256": hashlib.sha256(config.read_bytes()).hexdigest(),
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert validate_model_assets(tmp_path)["status"] == "test"
    checkpoint.write_bytes(b"changed")
    with pytest.raises(RuntimeError, match="checkpoint SHA-256"):
        validate_model_assets(tmp_path)
