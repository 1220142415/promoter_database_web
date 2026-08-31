import json

import numpy as np
import pytest

from prediction_service.formats import ScanArtifactWriter
from prediction_service.jobs import _write_fasta_index
from prediction_service.storage import JobStorage
from prediction_service.validation import FastaRecord


def test_json_scan_writer_streams_plus_and_minus(tmp_path):
    writer = ScanArtifactWriter(
        tmp_path,
        ["json"],
        [("contig", 105)],
        model_version="test",
        checkpoint_sha256="sha",
        stride=1,
    )
    writer.add_scores("contig", 105, "+", np.array([0.1, 0.2], dtype=np.float32), upstream_len=80)
    writer.add_scores("contig", 105, "-", np.array([0.3, 0.4], dtype=np.float32), upstream_len=80)
    artifacts = writer.close(success=True)

    rows = json.loads((tmp_path / "scores.json").read_text(encoding="utf-8"))
    assert [row["strand"] for row in rows] == ["+", "+", "-", "-"]
    assert [row["anchor_position_0based"] for row in rows] == [80, 81, 23, 24]
    assert artifacts[0]["filename"] == "scores.json"


def test_fasta_index_matches_wrapped_fasta(tmp_path):
    storage = JobStorage(tmp_path)
    job_id = "c" * 32
    storage.create(job_id)
    records = (FastaRecord("one", "A" * 81), FastaRecord("two", "C" * 4))
    storage.write_text(job_id, "input.fasta", ">one\n" + "A" * 80 + "\nA\n>two\nCCCC\n")
    path = _write_fasta_index(storage, job_id, records)
    assert path.read_text().splitlines() == ["one\t81\t5\t80\t81", "two\t4\t93\t4\t5"]


def test_all_scan_formats_are_readable(tmp_path):
    pyarrow = pytest.importorskip("pyarrow.parquet")
    pybigwig = pytest.importorskip("pyBigWig")
    writer = ScanArtifactWriter(
        tmp_path,
        ["bigwig", "parquet", "gff3", "json"],
        [("contig", 105)],
        model_version="test",
        checkpoint_sha256="a" * 64,
        stride=1,
    )
    values = np.arange(6, dtype=np.float32) / 10
    writer.add_scores("contig", 105, "+", values, upstream_len=80)
    writer.add_scores("contig", 105, "-", values, upstream_len=80)
    artifacts = writer.close(success=True)

    plus = pybigwig.open(str(tmp_path / "scores.plus.bw"))
    minus = pybigwig.open(str(tmp_path / "scores.minus.bw"))
    try:
        assert len(plus.intervals("contig")) == 6
        assert len(minus.intervals("contig")) == 6
    finally:
        plus.close()
        minus.close()
    assert pyarrow.read_table(tmp_path / "scores.parquet").num_rows == 12
    assert len(json.loads((tmp_path / "scores.json").read_text(encoding="utf-8"))) == 12
    assert (tmp_path / "scores.gff3").read_text(encoding="utf-8").count("\tRAPPtor\t") == 12
    assert {artifact["format"] for artifact in artifacts} == {"bigwig", "parquet", "gff3", "json"}
