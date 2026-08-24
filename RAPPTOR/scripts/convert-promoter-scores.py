#!/usr/bin/env python3
"""Convert per-genome raw RAPPTOR Parquet scores into strand BigWig files."""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
from collections import defaultdict
from pathlib import Path


ACCESSION_RE = re.compile(r"(GC[AF]_\d{9}\.\d+)")
REQUIRED_COLUMNS = {"Sequence_ID", "Start", "End", "Score", "Strand"}
SIDECAR_COLUMNS = {"Sequence_ID", "Position", "Score", "Strand"}


class ScoreValidationError(ValueError):
    pass


def accession_from_path(path: Path) -> str:
    accessions = set(ACCESSION_RE.findall(path.name))
    if not accessions:
        raise ScoreValidationError(f"{path}: filename does not contain a GCA/GCF accession")
    if len(accessions) != 1:
        raise ScoreValidationError(f"{path}: filename must contain exactly one GCA/GCF accession")
    return accessions.pop()


def read_fai(path: Path) -> list[tuple[str, int]]:
    if not path.is_file():
        raise ScoreValidationError(f"{path}: FASTA .fai index is missing")
    sequences: list[tuple[str, int]] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) < 2:
                raise ScoreValidationError(f"{path}:{line_number}: invalid FASTA index row")
            name = fields[0]
            try:
                length = int(fields[1])
            except ValueError as exc:
                raise ScoreValidationError(f"{path}:{line_number}: invalid sequence length") from exc
            if not name or length < 1 or name in seen:
                raise ScoreValidationError(f"{path}:{line_number}: invalid or duplicate sequence")
            seen.add(name)
            sequences.append((name, length))
    if not sequences:
        raise ScoreValidationError(f"{path}: FASTA index contains no sequences")
    return sequences


def load_records(path: Path, sequence_lengths: dict[str, int], stride: int):
    try:
        import pyarrow.parquet as parquet
    except ImportError as exc:
        raise RuntimeError("Parquet conversion requires pyarrow") from exc

    parquet_file = parquet.ParquetFile(path)
    available = set(parquet_file.schema_arrow.names)
    if REQUIRED_COLUMNS <= available:
        coordinate_mode = "start-end"
        columns_to_read = REQUIRED_COLUMNS
    elif SIDECAR_COLUMNS <= available:
        coordinate_mode = "position"
        columns_to_read = SIDECAR_COLUMNS
    else:
        raise ScoreValidationError(
            f"{path}: Parquet must contain either {sorted(REQUIRED_COLUMNS)} "
            f"or sidecar columns {sorted(SIDECAR_COLUMNS)}"
        )

    records: dict[str, dict[str, list[tuple[int, int, float]]]] = {
        "+": defaultdict(list),
        "-": defaultdict(list),
    }
    seen: set[tuple[str, int, str]] = set()
    for batch in parquet_file.iter_batches(columns=sorted(columns_to_read), batch_size=100_000):
        columns = batch.to_pydict()
        rows = len(columns["Sequence_ID"])
        for index in range(rows):
            sequence = str(columns["Sequence_ID"][index])
            raw_start = columns["Position"][index] if coordinate_mode == "position" else columns["Start"][index]
            raw_end = raw_start + 1 if coordinate_mode == "position" else columns["End"][index]
            raw_score = columns["Score"][index]
            try:
                if isinstance(raw_start, bool) or isinstance(raw_end, bool) or isinstance(raw_score, bool):
                    raise ValueError
                start = int(raw_start)
                end = int(raw_end)
                score = float(raw_score)
            except (TypeError, ValueError) as exc:
                raise ScoreValidationError(f"{path}: row {index + 1}: non-numeric coordinate or score") from exc
            if raw_start != start or raw_end != end:
                raise ScoreValidationError(f"{path}: row {index + 1}: coordinates must be integers")
            strand = str(columns["Strand"][index])
            length = sequence_lengths.get(sequence)
            if length is None:
                raise ScoreValidationError(f"{path}: unknown FASTA sequence {sequence!r}")
            if strand not in {"+", "-"}:
                raise ScoreValidationError(f"{path}: invalid strand {strand!r}")
            if start < 0 or end != start + 1 or end > length:
                raise ScoreValidationError(f"{path}: invalid interval {sequence}:{start}-{end}")
            if not math.isfinite(score) or score < 0 or score > 1:
                raise ScoreValidationError(f"{path}: score outside [0,1] at {sequence}:{start}")
            key = (sequence, start, strand)
            if key in seen:
                raise ScoreValidationError(f"{path}: duplicate score at {sequence}:{start} ({strand})")
            seen.add(key)
            records[strand][sequence].append((start, end, score))

    for strand, by_sequence in records.items():
        if not by_sequence:
            raise ScoreValidationError(f"{path}: no records for {strand} strand")
        for sequence, values in by_sequence.items():
            values.sort(key=lambda value: value[0])
            starts = [value[0] for value in values]
            if len(starts) > 1 and any(right - left != stride for left, right in zip(starts, starts[1:])):
                raise ScoreValidationError(
                    f"{path}: {sequence} {strand} strand does not have a constant {stride} bp step"
                )
    return records


def write_bigwig(path: Path, sequences: list[tuple[str, int]], records, strand: str):
    try:
        import pyBigWig
    except ImportError as exc:
        raise RuntimeError("BigWig conversion requires pyBigWig") from exc

    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        with pyBigWig.open(str(temporary), "w") as bigwig:
            bigwig.addHeader(sequences)
            for sequence, _length in sequences:
                values = records[strand].get(sequence, [])
                if not values:
                    continue
                bigwig.addEntries(
                    [sequence] * len(values),
                    [value[0] for value in values],
                    ends=[value[1] for value in values],
                    values=[value[2] for value in values],
                )
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    os.replace(temporary, path)


def convert_file(path: Path, release_root: Path, stride: int) -> tuple[str, int, int]:
    accession = accession_from_path(path)
    object_root = release_root / "objects" / accession
    sequences = read_fai(object_root / "reference.fa.gz.fai")
    sequence_lengths = dict(sequences)
    records = load_records(path, sequence_lengths, stride)
    write_bigwig(object_root / "promoter-scores.plus.bw", sequences, records, "+")
    write_bigwig(object_root / "promoter-scores.minus.bw", sequences, records, "-")
    return accession, sum(len(values) for values in records["+"].values()), sum(
        len(values) for values in records["-"].values()
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--score-root", type=Path, required=True)
    parser.add_argument("--release-root", type=Path, required=True)
    parser.add_argument("--stride", type=int, default=50)
    args = parser.parse_args()
    if args.stride < 1:
        parser.error("--stride must be positive")
    files = sorted(args.score_root.rglob("*.parquet"))
    if not files:
        raise ScoreValidationError(f"{args.score_root}: no Parquet files found")
    expected_accessions = {
        object_root.name
        for object_root in (args.release_root / "objects").iterdir()
        if object_root.is_dir()
    }
    if not expected_accessions:
        raise ScoreValidationError(f"{args.release_root}: no release objects found")
    files_by_accession: dict[str, Path] = {}
    for path in files:
        accession = accession_from_path(path)
        if accession not in expected_accessions:
            continue
        if accession in files_by_accession:
            raise ScoreValidationError(f"duplicate Parquet files for {accession}")
        files_by_accession[accession] = path
    missing_accessions = expected_accessions - files_by_accession.keys()
    if missing_accessions:
        raise ScoreValidationError(f"missing Parquet files for accessions: {sorted(missing_accessions)[:5]}")

    total_plus = 0
    total_minus = 0
    for accession, path in sorted(files_by_accession.items()):
        converted, plus_count, minus_count = convert_file(path, args.release_root, args.stride)
        total_plus += plus_count
        total_minus += minus_count
        print(f"{converted}\tplus={plus_count}\tminus={minus_count}")
    print(f"Converted {len(files_by_accession)} genomes; plus={total_plus}; minus={total_minus}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ScoreValidationError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2)
