from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
from typing import Iterable

import numpy as np


FORMAT_MIME = {
    "bigwig": "application/x-bigwig",
    "parquet": "application/vnd.apache.parquet",
    "gff3": "text/plain; charset=utf-8",
    "json": "application/json; charset=utf-8",
}

SMOOTHING_SIGMA = 1.0
PEAK_DISTANCE = 10
PEAK_CUTOFF = 0.9
PROMOTER_WINDOW_LENGTH = 100
# The model scores a 100 bp promoter window with the historical 80/20 anchor.
MODEL_UPSTREAM_LENGTH = 80
MODEL_DOWNSTREAM_LENGTH = 20
PROMOTER_DISPLAY_UPSTREAM_LENGTH = 79
PROMOTER_DISPLAY_DOWNSTREAM_LENGTH = 20


def peak_distance_samples(stride: int) -> int:
    """Convert the 10 bp separation rule to the sampled score grid."""
    return max(1, math.ceil(PEAK_DISTANCE / stride))


def scan_output_formats(formats: Iterable[str] | None, stride: int) -> tuple[str, ...]:
    """Every dense genome scan calls peaks, including requests from older clients."""
    selected = tuple(dict.fromkeys(formats or ("bigwig", "parquet")))
    if stride == 1 and "gff3" not in selected:
        selected += ("gff3",)
    return selected


class ArtifactFormatError(RuntimeError):
    pass


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ScanArtifactWriter:
    """Stream all requested genome-scan formats without retaining all scores."""

    def __init__(
        self,
        job_dir: Path,
        formats: Iterable[str],
        records: Iterable[tuple[str, int]],
        *,
        model_version: str,
        checkpoint_sha256: str,
        stride: int,
        score_cutoff: float | None = None,
    ) -> None:
        self.job_dir = Path(job_dir)
        self.formats = tuple(dict.fromkeys(formats))
        if not self.formats:
            raise ArtifactFormatError("at least one output format is required")
        unknown = set(self.formats).difference(FORMAT_MIME)
        if unknown:
            raise ArtifactFormatError(f"unsupported output format(s): {', '.join(sorted(unknown))}")
        self.records = tuple(records)
        self.stride = int(stride)
        if self.stride < 1:
            raise ArtifactFormatError("stride must be at least 1")
        self.peak_distance_samples = peak_distance_samples(self.stride)
        self.score_cutoff = float(score_cutoff) if score_cutoff is not None else None
        self.peak_cutoff = self.score_cutoff if self.score_cutoff is not None else PEAK_CUTOFF
        self._counter = 0
        self._gff_counter = 0
        self._json_counter = 0
        self._peak_counter = 0
        self._closed = False
        self._handles: dict[str, object] = {}
        self._tmp_paths: dict[str, Path] = {}
        self._final_paths: dict[str, Path] = {}
        self._parquet_writer = None
        self._parquet_schema = None
        self._bigwigs: dict[str, object] = {}

        try:
            for fmt in self.formats:
                if fmt == "bigwig":
                    continue
                elif fmt == "parquet":
                    self._open_parquet(model_version, checkpoint_sha256)
                elif fmt == "gff3":
                    self._open_text("scores.gff3", "gff3")
                    handle = self._handles["gff3"]
                    handle.write("##gff-version 3\n")
                    handle.write(f"##RAPPtor-model-version {model_version}\n")
                    handle.write(f"##RAPPtor-checkpoint-sha256 {checkpoint_sha256}\n")
                    handle.write(f"##RAPPtor-scan-stride {self.stride}\n")
                    handle.write("##RAPPtor-window-start-coordinate-system reference_0based\n")
                    handle.write(f"##RAPPtor-score-smoothing gaussian sigma={SMOOTHING_SIGMA:g} mode=reflect\n")
                    cutoff = "none" if self.score_cutoff is None else f">{self.score_cutoff:g}"
                    handle.write(f"##RAPPtor-score-cutoff {cutoff}\n")
                    self._open_text("promoters.gff3", "promoters")
                    promoter_handle = self._handles["promoters"]
                    promoter_handle.write("##gff-version 3\n")
                elif fmt == "json":
                    self._open_text("scores.json", "json")
                    self._handles["json"].write("[\n")
        except Exception:
            self.close(success=False)
            raise

    def _temp_path(self, name: str) -> tuple[Path, Path]:
        final = self.job_dir / name
        temporary = self.job_dir / f".{name}.tmp-{os.getpid()}"
        self._tmp_paths[name] = temporary
        self._final_paths[name] = final
        return temporary, final

    def _open_text(self, name: str, key: str) -> Path:
        temporary, _ = self._temp_path(name)
        handle = temporary.open("w", encoding="utf-8", newline="")
        self._handles[key] = handle
        return temporary

    def _open_parquet(self, model_version: str, checkpoint_sha256: str) -> None:
        try:
            import pyarrow as pa
            import pyarrow.parquet as pq
        except ImportError as exc:
            raise ArtifactFormatError("parquet output requires pyarrow") from exc
        temporary, _ = self._temp_path("scores.parquet")
        schema = pa.schema(
            [
                ("sequence_id", pa.string()),
                ("window_start_0based", pa.int64()),
                ("anchor_position_0based", pa.int64()),
                ("score", pa.float32()),
                ("strand", pa.string()),
            ],
            metadata={
                b"rapptor_model_version": model_version.encode(),
                b"rapptor_checkpoint_sha256": checkpoint_sha256.encode(),
                b"rapptor_stride": str(self.stride).encode(),
                b"rapptor_window_start_coordinate_system": b"reference_0based",
                b"rapptor_score_cutoff": b"none (unfiltered)",
            },
        )
        self._parquet_schema = schema
        self._parquet_writer = pq.ParquetWriter(temporary, schema, compression="zstd")

    def _open_bigwig(self, strand: str) -> None:
        try:
            import pyBigWig
        except ImportError as exc:
            raise ArtifactFormatError("bigwig output requires pyBigWig") from exc
        suffix = "plus" if strand == "+" else "minus"
        temporary, _ = self._temp_path(f"scores.{suffix}.bw")
        bigwig = pyBigWig.open(str(temporary), "w")
        bigwig.addHeader(list(self.records))
        self._bigwigs[strand] = bigwig

    @staticmethod
    def _chunks(
        scores: np.ndarray,
        sequence_length: int,
        strand: str,
        stride: int,
        upstream_len: int,
        window_length: int,
    ):
        size = len(scores)
        for start in range(0, size, 100_000):
            stop = min(size, start + 100_000)
            if strand == "+":
                indices = np.arange(start, stop, dtype=np.int64)
            else:
                indices = np.arange(size - start - 1, size - stop - 1, -1, dtype=np.int64)
            strand_starts = indices * stride
            if strand == "+":
                window_starts = strand_starts
                anchor_positions = window_starts + upstream_len
            else:
                window_starts = sequence_length - window_length - strand_starts
                anchor_positions = sequence_length - strand_starts - upstream_len - 1
            if (
                np.any(window_starts < 0)
                or np.any(window_starts + window_length > sequence_length)
                or np.any(anchor_positions < 0)
                or np.any(anchor_positions >= sequence_length)
            ):
                raise ValueError("score coordinates fall outside the input sequence")
            yield indices, window_starts, anchor_positions, np.asarray(scores[indices], dtype=np.float32)

    def add_scores(
        self,
        sequence_id: str,
        sequence_length: int,
        strand: str,
        scores: np.ndarray,
        *,
        upstream_len: int,
        window_length: int,
    ) -> None:
        if self._closed:
            raise RuntimeError("artifact writer is closed")
        if strand not in {"+", "-"}:
            raise ValueError("strand must be '+' or '-'")
        if window_length <= 0 or window_length > sequence_length:
            raise ValueError("window_length must be within the input sequence")
        if "gff3" in self.formats and (
            upstream_len != MODEL_UPSTREAM_LENGTH or window_length != PROMOTER_WINDOW_LENGTH
        ):
            raise ValueError("promoter peak output requires the model's 80/20 bp window")
        raw_scores = np.asarray(scores, dtype=np.float32)
        if "bigwig" in self.formats and len(raw_scores) and strand not in self._bigwigs:
            self._open_bigwig(strand)
        smoothed_scores = None
        peak_indices: set[int] = set()
        if ({"bigwig", "gff3"}.intersection(self.formats)) and len(raw_scores):
            from scipy.ndimage import gaussian_filter1d

            ordered_scores = raw_scores if strand == "+" else raw_scores[::-1]
            ordered_smoothed = gaussian_filter1d(
                ordered_scores.astype(float), SMOOTHING_SIGMA, mode="reflect"
            )
            if strand == "+":
                smoothed_scores = ordered_smoothed
            else:
                smoothed_scores = ordered_smoothed[::-1]
            if "gff3" in self.formats:
                from scipy.signal import find_peaks

                indices, _ = find_peaks(ordered_smoothed, distance=self.peak_distance_samples)
                ordered_peaks = {int(index) for index in indices if ordered_smoothed[index] > self.peak_cutoff}
                peak_indices = ordered_peaks if strand == "+" else {
                    len(raw_scores) - index - 1 for index in ordered_peaks
                }
        for score_indices, window_starts, anchor_positions, values in self._chunks(
            raw_scores, sequence_length, strand, self.stride, upstream_len, window_length
        ):
            count = len(values)
            if not count:
                continue
            if "bigwig" in self.formats:
                bigwig = self._bigwigs[strand]
                bigwig_values = np.asarray(smoothed_scores[score_indices], dtype=np.float32)
                bigwig.addEntries(
                    [sequence_id] * count,
                    anchor_positions.tolist(),
                    ends=(anchor_positions + 1).tolist(),
                    values=bigwig_values.tolist(),
                )
            if "parquet" in self.formats:
                import pyarrow as pa

                table = pa.Table.from_arrays(
                    [
                        pa.array([sequence_id] * count, type=pa.string()),
                        pa.array(window_starts, type=pa.int64()),
                        pa.array(anchor_positions, type=pa.int64()),
                        pa.array(values, type=pa.float32()),
                        pa.array([strand] * count, type=pa.string()),
                    ],
                    schema=self._parquet_schema,
                )
                self._parquet_writer.write_table(table)
            for index in range(count):
                window_start = int(window_starts[index])
                anchor = int(anchor_positions[index])
                score = float(values[index])
                if "gff3" in self.formats:
                    smoothed_score = float(smoothed_scores[score_indices[index]])
                    if self.score_cutoff is None or smoothed_score > self.score_cutoff:
                        self._gff_counter += 1
                        self._handles["gff3"].write(
                            f"{sequence_id}\tRAPPtor\tpromoter_candidate\t{anchor + 1}\t{anchor + 1}\t"
                            f"{smoothed_score:.8f}\t{strand}\t.\tID=rapptor_hit_{self._gff_counter:012d};"
                            f"window_start_0based={window_start};stride={self.stride}\n"
                        )
                    if int(score_indices[index]) in peak_indices:
                        self._peak_counter += 1
                        promoter_id = f"rapptor_promoter_{self._peak_counter:09d}"
                        anchor_1based = anchor + 1
                        if strand == "+":
                            display_start = anchor_1based - PROMOTER_DISPLAY_UPSTREAM_LENGTH
                            display_end = anchor_1based + PROMOTER_DISPLAY_DOWNSTREAM_LENGTH
                        else:
                            display_start = anchor_1based - PROMOTER_DISPLAY_DOWNSTREAM_LENGTH
                            display_end = anchor_1based + PROMOTER_DISPLAY_UPSTREAM_LENGTH
                        display_available = display_start >= 1 and display_end <= sequence_length
                        if not display_available:
                            display_start = anchor_1based
                            display_end = anchor_1based
                        self._handles["promoters"].write(
                            f"{sequence_id}\tRAPPtor\tpromoter\t{display_start}\t"
                            f"{display_end}\t"
                            f"{smoothed_score:.8f}\t{strand}\t.\tID={promoter_id};Name=Predicted+promoter\n"
                        )
                cutoff_score = (
                    float(smoothed_scores[score_indices[index]])
                    if "gff3" in self.formats else score
                )
                passes_cutoff = self.score_cutoff is None or cutoff_score > self.score_cutoff
                if passes_cutoff:
                    self._counter += 1
                if "json" in self.formats and (self.score_cutoff is None or score > self.score_cutoff):
                    self._json_counter += 1
                    if self._json_counter > 1:
                        self._handles["json"].write(",\n")
                    self._handles["json"].write(
                        json.dumps(
                            {
                                "sequence_id": sequence_id,
                                "window_start_0based": window_start,
                                "anchor_position_0based": anchor,
                                "score": score,
                                "strand": strand,
                            },
                            separators=(",", ":"),
                        )
                    )

    @property
    def passing_score_count(self) -> int:
        return self._counter

    @property
    def peak_count(self) -> int:
        return self._peak_counter

    def close(self, *, success: bool) -> list[dict]:
        if self._closed:
            return []
        self._closed = True
        try:
            for handle in self._handles.values():
                if "json" in self.formats and handle is self._handles.get("json"):
                    handle.write("\n]\n")
                handle.close()
            if self._parquet_writer is not None:
                self._parquet_writer.close()
            for bigwig in self._bigwigs.values():
                bigwig.close()
            if not success:
                return []
            for temporary, final in zip(self._tmp_paths.values(), self._final_paths.values()):
                os.replace(temporary, final)
            artifacts = []
            for name, path in self._final_paths.items():
                fmt = "bigwig" if name.endswith(".bw") else name.split(".")[-1]
                artifacts.append(
                    {
                        "filename": path.name,
                        "format": fmt,
                        "content_type": FORMAT_MIME[fmt],
                        "size_bytes": path.stat().st_size,
                        "sha256": _sha256_file(path),
                    }
                )
            return artifacts
        finally:
            for temporary in self._tmp_paths.values():
                temporary.unlink(missing_ok=True)
