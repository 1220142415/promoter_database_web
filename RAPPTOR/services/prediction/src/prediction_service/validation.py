from __future__ import annotations

import re
from dataclasses import dataclass


IUPAC_DNA = frozenset("ACGTNRYWSKMBDHV")
CANONICAL_DNA = frozenset("ACGT")
HEADER_TOKEN = re.compile(r"^[A-Za-z0-9_.:|+\-]{1,200}$")


class InputValidationError(ValueError):
    pass


@dataclass(frozen=True)
class FastaRecord:
    identifier: str
    sequence: str


@dataclass(frozen=True)
class ValidatedFasta:
    records: tuple[FastaRecord, ...]
    total_bases: int
    ambiguous_bases: int

    @property
    def ambiguous_fraction(self) -> float:
        return self.ambiguous_bases / self.total_bases if self.total_bases else 0.0

    def to_fasta(self) -> str:
        chunks: list[str] = []
        for record in self.records:
            chunks.append(f">{record.identifier}")
            seq = record.sequence
            chunks.extend(seq[i : i + 80] for i in range(0, len(seq), 80))
        return "\n".join(chunks) + "\n"


def _normalize_sequence(raw: str, *, label: str, max_bases: int, max_ambiguous_fraction: float) -> tuple[str, int]:
    if not isinstance(raw, str):
        raise InputValidationError(f"{label} must be DNA text.")
    sequence = "".join(raw.split()).upper()
    if not sequence:
        raise InputValidationError(f"{label} is required.")
    if len(sequence) > max_bases:
        raise InputValidationError(f"{label} must be at most {max_bases:,} bp.")
    invalid = sorted(set(sequence).difference(IUPAC_DNA))
    if invalid:
        raise InputValidationError(f"{label} contains unsupported characters: {''.join(invalid[:10])}.")
    ambiguous = sum(base not in CANONICAL_DNA for base in sequence)
    fraction = ambiguous / len(sequence)
    if fraction > max_ambiguous_fraction:
        raise InputValidationError(
            f"{label} has {fraction:.1%} ambiguous bases; maximum is {max_ambiguous_fraction:.1%}."
        )
    # The current RAPPTOR encoder maps non-ACGT symbols to an all-zero channel.
    # Normalize all supported IUPAC ambiguity codes to N explicitly.
    normalized = "".join(base if base in CANONICAL_DNA else "N" for base in sequence)
    return normalized, ambiguous


def validate_sequence(raw: str, *, label: str, min_bases: int, max_bases: int, max_ambiguous_fraction: float) -> str:
    sequence, _ = _normalize_sequence(
        raw,
        label=label,
        max_bases=max_bases,
        max_ambiguous_fraction=max_ambiguous_fraction,
    )
    if len(sequence) < min_bases:
        raise InputValidationError(f"{label} must contain at least {min_bases} bp.")
    return sequence


def validate_fasta(raw: str, *, max_bases: int, max_ambiguous_fraction: float) -> ValidatedFasta:
    if not isinstance(raw, str) or not raw.strip():
        raise InputValidationError("FASTA is required.")
    records: list[FastaRecord] = []
    seen: set[str] = set()
    current_id: str | None = None
    current_lines: list[str] = []
    total_bases = 0
    total_ambiguous = 0

    def flush() -> None:
        nonlocal current_id, current_lines, total_bases, total_ambiguous
        if current_id is None:
            return
        if not current_lines:
            raise InputValidationError(f"FASTA record {current_id!r} is empty.")
        remaining = max_bases - total_bases
        seq, ambiguous = _normalize_sequence(
            "".join(current_lines),
            label=f"FASTA record {current_id}",
            max_bases=max(remaining, 0),
            max_ambiguous_fraction=1.0,
        )
        total_bases += len(seq)
        total_ambiguous += ambiguous
        if total_bases > max_bases:
            raise InputValidationError(f"FASTA must be at most {max_bases:,} bp.")
        records.append(FastaRecord(current_id, seq))
        current_id = None
        current_lines = []

    for line_number, raw_line in enumerate(raw.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(">"):
            flush()
            header = line[1:].strip()
            if not header:
                raise InputValidationError(f"FASTA header at line {line_number} is empty.")
            identifier = header.split()[0]
            if not HEADER_TOKEN.fullmatch(identifier):
                raise InputValidationError(f"FASTA identifier {identifier!r} contains unsupported characters.")
            if identifier in seen:
                raise InputValidationError(f"Duplicate FASTA identifier: {identifier}.")
            seen.add(identifier)
            current_id = identifier
            current_lines = []
        else:
            if current_id is None:
                raise InputValidationError(f"Add a FASTA header before sequence data at line {line_number}.")
            current_lines.append(line)
    flush()

    if not records:
        raise InputValidationError("FASTA contains no records.")
    fraction = total_ambiguous / total_bases if total_bases else 0.0
    if fraction > max_ambiguous_fraction:
        raise InputValidationError(
            f"FASTA has {fraction:.1%} ambiguous bases; maximum is {max_ambiguous_fraction:.1%}."
        )
    return ValidatedFasta(tuple(records), total_bases, total_ambiguous)
