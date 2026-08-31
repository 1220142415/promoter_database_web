from __future__ import annotations

import hashlib
import json
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
        self._counter = 0
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
                    self._open_bigwig("+", model_version, checkpoint_sha256)
                    self._open_bigwig("-", model_version, checkpoint_sha256)
                elif fmt == "parquet":
                    self._open_parquet(model_version, checkpoint_sha256)
                elif fmt == "gff3":
                    self._open_text("scores.gff3")
                    handle = self._handles["gff3"]
                    handle.write("##gff-version 3\n")
                    handle.write(f"##RAPPtor-model-version {model_version}\n")
                    handle.write(f"##RAPPtor-checkpoint-sha256 {checkpoint_sha256}\n")
                    handle.write(f"##RAPPtor-scan-stride {self.stride}\n")
                    handle.write("##RAPPtor-score-cutoff none\n")
                elif fmt == "json":
                    self._open_text("scores.json")
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

    def _open_text(self, name: str) -> Path:
        temporary, _ = self._temp_path(name)
        handle = temporary.open("w", encoding="utf-8", newline="")
        key = "gff3" if name.endswith(".gff3") else "json"
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
            },
        )
        self._parquet_schema = schema
        self._parquet_writer = pq.ParquetWriter(temporary, schema, compression="zstd")

    def _open_bigwig(self, strand: str, model_version: str, checkpoint_sha256: str) -> None:
        try:
            import pyBigWig
        except ImportError as exc:
            raise ArtifactFormatError("bigwig output requires pyBigWig") from exc
        suffix = "plus" if strand == "+" else "minus"
        temporary, _ = self._temp_path(f"scores.{suffix}.bw")
        bigwig = pyBigWig.open(str(temporary), "w")
        bigwig.addHeader(list(self.records))
        self._bigwigs[strand] = bigwig
        del model_version, checkpoint_sha256

    @staticmethod
    def _chunks(scores: np.ndarray, sequence_length: int, strand: str, stride: int, upstream_len: int):
        size = len(scores)
        for start in range(0, size, 100_000):
            stop = min(size, start + 100_000)
            if strand == "+":
                indices = np.arange(start, stop, dtype=np.int64)
            else:
                indices = np.arange(size - start - 1, size - stop - 1, -1, dtype=np.int64)
            window_starts = indices * stride
            anchor_positions = window_starts + upstream_len
            if strand == "-":
                anchor_positions = sequence_length - anchor_positions - 1
            yield indices, window_starts, anchor_positions, np.asarray(scores[indices], dtype=np.float32)

    def add_scores(
        self,
        sequence_id: str,
        sequence_length: int,
        strand: str,
        scores: np.ndarray,
        *,
        upstream_len: int,
    ) -> None:
        if self._closed:
            raise RuntimeError("artifact writer is closed")
        if strand not in {"+", "-"}:
            raise ValueError("strand must be '+' or '-'")
        for _indices, window_starts, anchor_positions, values in self._chunks(
            scores, sequence_length, strand, self.stride, upstream_len
        ):
            count = len(values)
            if not count:
                continue
            if "bigwig" in self.formats:
                bigwig = self._bigwigs[strand]
                bigwig.addEntries(
                    [sequence_id] * count,
                    anchor_positions.tolist(),
                    ends=(anchor_positions + 1).tolist(),
                    values=values.tolist(),
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
                self._counter += 1
                window_start = int(window_starts[index])
                anchor = int(anchor_positions[index])
                score = float(values[index])
                if "gff3" in self.formats:
                    self._handles["gff3"].write(
                        f"{sequence_id}\tRAPPtor\tpromoter_candidate\t{anchor + 1}\t{anchor + 1}\t"
                        f"{score:.8f}\t{strand}\t.\tID=rapptor_hit_{self._counter:012d};"
                        f"window_start_0based={window_start};stride={self.stride}\n"
                    )
                if "json" in self.formats:
                    if self._counter > 1:
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
