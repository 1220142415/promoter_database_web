#!/usr/bin/env python3
"""Build and validate the public RAPPTOR cyanobacteria browser release."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import shutil
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote


RELEASE_ID = "2026-08-27"
HF_REVISION = "1f43a48b29419a4a95d2970931fdd787d496953a"
HF_ASSET_BASE = (
    f"https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes/resolve/{HF_REVISION}/"
    "cyanobacteria/releases/2026-08-27"
)
PREDICTION_WINDOW = {
    "lengthBp": 100,
    "upstreamBp": 80,
    "downstreamBp": 20,
    "anchorAttribute": "peak_position",
}
ASSETS = {
    "fasta": "reference.fa.gz",
    "fastaFai": "reference.fa.gz.fai",
    "fastaGzi": "reference.fa.gz.gzi",
    "predictedPromoters": "predicted-promoters.gff3.gz",
    "predictedPromotersIndex": "predicted-promoters.gff3.gz.tbi",
    "promoterScoresPlus": "candidate-peak-scores.plus.bw",
    "promoterScoresMinus": "candidate-peak-scores.minus.bw",
    "ncbiAnnotations": "genome-annotations.gff3.gz",
    "ncbiAnnotationsIndex": "genome-annotations.gff3.gz.tbi",
    "metadata": "metadata.json",
    "candidateSource": "sources/candidate-peaks.source.gff3.gz",
    "predictionSource": "sources/final-predictions.source.gff3.gz",
    "annotationSource": "sources/genome-annotation.source.gff3.gz",
    "experimentalTss": "experimentally-supported-tss.gff3.gz",
    "experimentalTssIndex": "experimentally-supported-tss.gff3.gz.tbi",
    "experimentalTssSource": "sources/experimentally-supported-tss.source.bed.gz",
}

GENOMES = {
    "ASM970v1": {
        "identifierType": "assembly name",
        "organismName": "Nostoc sp. PCC 7120",
        "strain": "PCC 7120",
        "genomeSizeBp": 7_211_789,
        "gcContent": 41.27,
        "contigCount": 7,
        "primarySequence": "NC_003272.1",
        "defaultLocus": "NC_003272.1:1-10000",
        "candidatePeakCount": 877_651,
        "candidatePeakStrands": {"plus": 438_561, "minus": 439_090},
        "predictedPromoterCount": 40_789,
        "predictedPromoterStrands": {"plus": 20_450, "minus": 20_339},
        "annotation": {
            "source": "NCBI",
            "label": "NCBI genome annotation",
            "description": "NCBI gene, CDS, rRNA, and tRNA features on the chromosome and six plasmids.",
            "featureCounts": {"gene": 6_050, "CDS": 6_107, "rRNA": 12, "tRNA": 70},
            "limitations": None,
        },
        "candidate": "gff3_cutoff_0/ASM970v1.smoothed_peaks_gt_0.gff3",
        "prediction": "cyanobacteria_promoter_annotations/ASM970v1.promoters_up80_down20.gff3",
        "annotationSourcePath": "cyanobacteria_gene_annotations/ASM970v1.ncbi.gff3",
        "experimentalTss": {
            "path": "experimentally_supported_tss_by_study/2011_22135468_GCF_000009705.1.bed",
            "seqidPrefix": "GCF_000009705.1:",
            "label": "Experimentally supported TSS (Mitschke et al., 2011)",
            "studyId": "2011_22135468_GCF_000009705.1",
            "pmid": "22135468",
            "year": 2011,
            "title": "Dynamics of transcriptional start site selection during nitrogen stress-induced cell differentiation in Anabaena sp. PCC7120.",
            "journal": "Proceedings of the National Academy of Sciences of the United States of America",
            "doi": "10.1073/pnas.1112724108",
            "assemblyAccession": "GCF_000009705.1",
            "expectedObservationCount": 13_705,
            "expectedUniqueTssCount": 13_705,
            "expectedStrands": {"plus": 6_929, "minus": 6_776},
            "expectedSequenceCount": 7,
            "methodBoundary": "Study-level TSS under the reported conditions; not universal promoter validation.",
            "hfPath": "experimentally_supported_tss_by_study/2011_22135468_GCF_000009705.1.bed",
            "hfAssetSha256": "f47d7a2623ceb9c9d4b164ea69827ae41671f0ce97a5e8fe47fbc5c0e8a3f283",
            "sourceManifestSha256": "1c27312b8a5fedd9973df058672e7da14d0e9ecfb67e0d019df20d556f85dac5",
        },
    },
    "Cf6912": {
        "identifierType": "dataset identifier",
        "organismName": "Chlorogloeopsis fritschii PCC 6912",
        "strain": "PCC 6912",
        "genomeSizeBp": 7_836_557,
        "gcContent": 41.51,
        "contigCount": 3,
        "primarySequence": "contig_1",
        "defaultLocus": "contig_1:1-10000",
        "candidatePeakCount": 963_037,
        "candidatePeakStrands": {"plus": 481_667, "minus": 481_370},
        "predictedPromoterCount": 36_353,
        "predictedPromoterStrands": {"plus": 18_191, "minus": 18_162},
        "annotation": {
            "source": "Prodigal",
            "label": "Prodigal CDS prediction",
            "description": (
                "Prodigal v2.6.3 CDS predictions (single-genome mode; translation table 11)."
            ),
            "featureCounts": {"CDS": 6_856},
            "limitations": (
                "No functional products, rRNA, or tRNA are predicted."
            ),
        },
        "candidate": "gff3_cutoff_0/Cf6912.smoothed_peaks_gt_0.gff3",
        "prediction": "cyanobacteria_promoter_annotations/Cf6912.promoters_up80_down20.gff3",
        "annotationSourcePath": "cyanobacteria_gene_annotations/Cf6912.prodigal.gff3",
    },
    "CP003597.1": {
        "identifierType": "sequence accession",
        "organismName": "Chroococcidiopsis thermalis PCC 7203",
        "strain": "PCC 7203",
        "genomeSizeBp": 6_315_792,
        "gcContent": 44.44,
        "contigCount": 1,
        "primarySequence": "CP003597.1",
        "defaultLocus": "CP003597.1:1-10000",
        "candidatePeakCount": 768_630,
        "candidatePeakStrands": {"plus": 384_248, "minus": 384_382},
        "predictedPromoterCount": 35_720,
        "predictedPromoterStrands": {"plus": 17_832, "minus": 17_888},
        "annotation": {
            "source": "NCBI",
            "label": "NCBI genome annotation",
            "description": "NCBI gene, CDS, rRNA, and tRNA features for CP003597.1.",
            "featureCounts": {"gene": 5_466, "CDS": 5_408, "rRNA": 9, "tRNA": 46},
            "limitations": None,
        },
        "candidate": "gff3_cutoff_0/CP003597.1.smoothed_peaks_gt_0.gff3",
        "prediction": "cyanobacteria_promoter_annotations/CP003597.1.promoters_up80_down20.gff3",
        "annotationSourcePath": "cyanobacteria_gene_annotations/CP003597.1.gff3",
    },
}


class ReleaseValidationError(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_fai(path: Path) -> list[tuple[str, int]]:
    sequences: list[tuple[str, int]] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) < 2:
                raise ReleaseValidationError(f"{path}:{line_number}: invalid FAI row")
            name = fields[0]
            try:
                length = int(fields[1])
            except ValueError as exc:
                raise ReleaseValidationError(f"{path}:{line_number}: invalid sequence length") from exc
            if not name or name in seen or length < 1:
                raise ReleaseValidationError(f"{path}:{line_number}: invalid or duplicate sequence")
            seen.add(name)
            sequences.append((name, length))
    if not sequences:
        raise ReleaseValidationError(f"{path}: no reference sequences")
    return sequences


def gff3_attribute(value: object) -> str:
    return quote(str(value), safe="._:-")


def parse_gff3_attributes(value: str) -> dict[str, str]:
    attributes: dict[str, str] = {}
    if value == ".":
        return attributes
    for item in value.split(";"):
        key, separator, raw_value = item.partition("=")
        if separator and key:
            attributes[key] = unquote(raw_value)
    return attributes


def normalize_experimental_tss_bed(
    source: Path,
    destination: Path,
    sequences: list[tuple[str, int]],
    config: dict,
) -> dict:
    sequence_order = {name: index for index, (name, _length) in enumerate(sequences)}
    sequence_lengths = dict(sequences)
    seqid_prefix = config["seqidPrefix"]
    records: list[tuple[int, int, int, int, str]] = []
    strands: Counter = Counter()
    observed_sequences: set[str] = set()
    unique_sites: set[tuple[str, int, str]] = set()

    with source.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip() or line.startswith("#"):
                continue
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) < 6:
                raise ReleaseValidationError(f"{source}:{line_number}: expected at least 6 BED columns")
            original_seqid, raw_start, raw_end, name, bed_score, strand = fields[:6]
            if not original_seqid.startswith(seqid_prefix):
                raise ReleaseValidationError(f"{source}:{line_number}: unexpected experimental TSS seqid")
            sequence = original_seqid[len(seqid_prefix):]
            if sequence not in sequence_lengths:
                raise ReleaseValidationError(f"{source}:{line_number}: unknown experimental TSS sequence {sequence}")
            try:
                bed_start = int(raw_start)
                bed_end = int(raw_end)
            except ValueError as exc:
                raise ReleaseValidationError(f"{source}:{line_number}: invalid experimental TSS coordinate") from exc
            if bed_start < 0 or bed_end != bed_start + 1 or bed_end > sequence_lengths[sequence]:
                raise ReleaseValidationError(f"{source}:{line_number}: experimental TSS must be an in-range single-base BED interval")
            if strand not in {"+", "-"}:
                raise ReleaseValidationError(f"{source}:{line_number}: experimental TSS strand must be + or -")
            if bed_score != ".":
                try:
                    score = float(bed_score)
                except ValueError as exc:
                    raise ReleaseValidationError(f"{source}:{line_number}: invalid BED score") from exc
                if not math.isfinite(score):
                    raise ReleaseValidationError(f"{source}:{line_number}: non-finite BED score")

            coordinate = bed_start + 1
            site = (sequence, coordinate, strand)
            unique_sites.add(site)
            strands[strand] += 1
            observed_sequences.add(sequence)
            attributes = {
                "ID": f"experimental_tss_{line_number:06d}",
                "Name": name,
                "evidence": "experimentally_supported",
                "study_id": config["studyId"],
                "pmid": config["pmid"],
                "assembly_accession": config["assemblyAccession"],
                "original_seqid": original_seqid,
            }
            if name:
                attributes["source_name"] = name
            attribute_text = ";".join(f"{key}={gff3_attribute(value)}" for key, value in attributes.items())
            gff = "\t".join([
                sequence,
                "RAPPTOR_experimental_TSS",
                "experimental_tss",
                str(coordinate),
                str(coordinate),
                ".",
                strand,
                ".",
                attribute_text,
            ])
            records.append((sequence_order[sequence], coordinate, 0 if strand == "+" else 1, line_number, gff))

    records.sort(key=lambda value: value[:4])
    with destination.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write("##gff-version 3\n")
        for _sequence_order, _coordinate, _strand_order, _line_number, record in records:
            handle.write(f"{record}\n")

    observed = {
        "observationCount": len(records),
        "uniqueTssCount": len(unique_sites),
        "duplicateObservationCount": len(records) - len(unique_sites),
        "strands": {"plus": strands["+"], "minus": strands["-"]},
        "sequenceCount": len(observed_sequences),
        "sequences": [name for name, _length in sequences if name in observed_sequences],
    }
    if observed["observationCount"] != config["expectedObservationCount"]:
        raise ReleaseValidationError(f"{source}: experimental TSS observation count differs from the study manifest")
    if observed["uniqueTssCount"] != config["expectedUniqueTssCount"]:
        raise ReleaseValidationError(f"{source}: experimental TSS unique-site count differs from the release contract")
    if observed["strands"] != config["expectedStrands"]:
        raise ReleaseValidationError(f"{source}: experimental TSS strand counts differ from the release contract")
    if observed["sequenceCount"] != config["expectedSequenceCount"]:
        raise ReleaseValidationError(f"{source}: experimental TSS sequence coverage differs from the release contract")
    return observed


def gff_record(path: Path, line_number: int, line: str) -> tuple[list[str], int, int, float | None]:
    fields = line.rstrip("\r\n").split("\t")
    if len(fields) != 9:
        raise ReleaseValidationError(f"{path}:{line_number}: expected 9 GFF3 columns")
    try:
        start = int(fields[3])
        end = int(fields[4])
    except ValueError as exc:
        raise ReleaseValidationError(f"{path}:{line_number}: invalid GFF3 coordinates") from exc
    if start < 1 or end < start:
        raise ReleaseValidationError(f"{path}:{line_number}: invalid GFF3 interval {start}-{end}")
    score = None
    if fields[5] != ".":
        try:
            score = float(fields[5])
        except ValueError as exc:
            raise ReleaseValidationError(f"{path}:{line_number}: invalid GFF3 score") from exc
        if not math.isfinite(score):
            raise ReleaseValidationError(f"{path}:{line_number}: non-finite GFF3 score")
    return fields, start, end, score


def read_peak_records(
    path: Path,
    sequence_lengths: dict[str, int],
) -> tuple[dict[str, dict[str, list[tuple[int, float]]]], Counter, set[tuple[str, int, str, float]]]:
    records: dict[str, dict[str, list[tuple[int, float]]]] = {
        "+": defaultdict(list),
        "-": defaultdict(list),
    }
    counts: Counter = Counter()
    above_threshold: set[tuple[str, int, str, float]] = set()
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip() or line.startswith("#"):
                continue
            fields, start, end, score = gff_record(path, line_number, line)
            sequence, feature_type, strand = fields[0], fields[2], fields[6]
            if sequence not in sequence_lengths:
                raise ReleaseValidationError(f"{path}:{line_number}: unknown reference sequence {sequence}")
            if end > sequence_lengths[sequence]:
                raise ReleaseValidationError(f"{path}:{line_number}: peak is outside the reference sequence")
            if feature_type != "promoter_peak" or start != end:
                raise ReleaseValidationError(f"{path}:{line_number}: expected a single-base promoter_peak")
            if strand not in records:
                raise ReleaseValidationError(f"{path}:{line_number}: promoter peak strand must be + or -")
            if score is None or score <= 0 or score > 1:
                raise ReleaseValidationError(f"{path}:{line_number}: model score must be in (0,1]")
            rounded = round(score, 8)
            records[strand][sequence].append((start - 1, rounded))
            counts[strand] += 1
            if score > 0.9:
                key = (sequence, start, strand, rounded)
                if key in above_threshold:
                    raise ReleaseValidationError(f"{path}:{line_number}: duplicate score > 0.9 peak")
                above_threshold.add(key)

    for strand, by_sequence in records.items():
        for sequence, values in by_sequence.items():
            values.sort(key=lambda value: value[0])
            previous = -1
            for start, _score in values:
                if start == previous:
                    raise ReleaseValidationError(f"{path}: duplicate {sequence}:{start + 1} ({strand}) peak")
                previous = start
    return records, counts, above_threshold


def read_final_peak_set(path: Path, sequence_lengths: dict[str, int]) -> tuple[set[tuple[str, int, str, float]], Counter]:
    values: set[tuple[str, int, str, float]] = set()
    counts: Counter = Counter()
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip() or line.startswith("#"):
                continue
            fields, start, end, score = gff_record(path, line_number, line)
            sequence, feature_type, strand = fields[0], fields[2], fields[6]
            if sequence not in sequence_lengths or end > sequence_lengths.get(sequence, 0):
                raise ReleaseValidationError(f"{path}:{line_number}: final peak does not match the reference")
            attributes = parse_gff3_attributes(fields[8])
            try:
                anchor = int(attributes.get(PREDICTION_WINDOW["anchorAttribute"], ""))
            except ValueError as exc:
                raise ReleaseValidationError(f"{path}:{line_number}: invalid promoter anchor") from exc
            expected_start = anchor - (
                PREDICTION_WINDOW["upstreamBp"] if strand == "+" else PREDICTION_WINDOW["downstreamBp"] - 1
            )
            expected_end = anchor + (
                PREDICTION_WINDOW["downstreamBp"] - 1 if strand == "+" else PREDICTION_WINDOW["upstreamBp"]
            )
            if (
                feature_type != "promoter" or strand not in {"+", "-"}
                or end - start + 1 != PREDICTION_WINDOW["lengthBp"]
                or (start, end) != (expected_start, expected_end)
                or attributes.get("upstream_length") != str(PREDICTION_WINDOW["upstreamBp"])
                or attributes.get("downstream_length") != str(PREDICTION_WINDOW["downstreamBp"])
            ):
                raise ReleaseValidationError(f"{path}:{line_number}: invalid 100 bp promoter interval")
            if score is None or not 0.9 < score <= 1:
                raise ReleaseValidationError(f"{path}:{line_number}: final peak does not satisfy score > 0.9")
            key = (sequence, anchor, strand, round(score, 8))
            if key in values:
                raise ReleaseValidationError(f"{path}:{line_number}: duplicate final promoter")
            values.add(key)
            counts[strand] += 1
    return values, counts


def require_exact_final_subset(
    genome_id: str,
    expected: set[tuple[str, int, str, float]],
    observed: set[tuple[str, int, str, float]],
) -> None:
    if observed == expected:
        return
    missing = sorted(expected - observed)[:3]
    extra = sorted(observed - expected)[:3]
    raise ReleaseValidationError(
        f"{genome_id}: final predictions are not the exact score > 0.9 subset; "
        f"missing={missing}, extra={extra}"
    )


def write_bigwig(path: Path, sequences: list[tuple[str, int]], records, strand: str) -> None:
    try:
        import pyBigWig
    except ImportError as exc:
        raise RuntimeError(
            "BigWig generation requires scripts/data/requirements-cyanobacteria.txt"
        ) from exc
    with pyBigWig.open(str(path), "w") as bigwig:
        bigwig.addHeader(sequences)
        for sequence, _length in sequences:
            values = records[strand].get(sequence, [])
            for offset in range(0, len(values), 100_000):
                chunk = values[offset : offset + 100_000]
                starts = [value[0] for value in chunk]
                bigwig.addEntries(
                    [sequence] * len(chunk),
                    starts,
                    ends=[start + 1 for start in starts],
                    values=[value[1] for value in chunk],
                )


def split_circular_record(fields: list[str], start: int, end: int, part: str) -> str:
    split_fields = list(fields)
    split_fields[3] = str(start)
    split_fields[4] = str(end)
    marker = f"rapptor_circular_origin_part={part}"
    split_fields[8] = marker if split_fields[8] == "." else f"{split_fields[8]};{marker}"
    return "\t".join(split_fields)


def sorted_gff(source: Path, destination: Path, sequences: list[tuple[str, int]]) -> tuple[Counter, int]:
    sequence_order = {name: index for index, (name, _length) in enumerate(sequences)}
    sequence_lengths = dict(sequences)
    headers: list[str] = []
    parsed_records: list[tuple[list[str], int, int, int]] = []
    records: list[tuple[int, int, int, int, int, str]] = []
    counts: Counter = Counter()
    circular_sequences: set[str] = set()
    with source.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            stripped = line.rstrip("\r\n")
            if not stripped:
                continue
            if stripped.startswith("#"):
                if not stripped.lower().startswith("##gff-version"):
                    headers.append(stripped)
                continue
            fields, start, end, _score = gff_record(source, line_number, stripped)
            sequence = fields[0]
            if sequence not in sequence_order:
                raise ReleaseValidationError(f"{source}:{line_number}: unknown sequence {sequence}")
            if fields[6] not in {"+", "-", ".", "?"}:
                raise ReleaseValidationError(f"{source}:{line_number}: invalid GFF3 strand")
            if fields[2].lower() == "region" and "is_circular=true" in fields[8].lower():
                circular_sequences.add(sequence)
            parsed_records.append((fields, start, end, line_number))
            counts[fields[2]] += 1

    circular_origin_splits = 0
    for fields, start, end, line_number in parsed_records:
        sequence = fields[0]
        length = sequence_lengths[sequence]
        if end <= length:
            records.append((sequence_order[sequence], start, end, line_number, 0, "\t".join(fields)))
            continue
        overflow_end = end - length
        if sequence not in circular_sequences or start > length or overflow_end < 1 or overflow_end >= start:
            raise ReleaseValidationError(f"{source}:{line_number}: annotation is outside the reference")
        circular_origin_splits += 1
        records.append((
            sequence_order[sequence], start, length, line_number, 1,
            split_circular_record(fields, start, length, "1/2"),
        ))
        records.append((
            sequence_order[sequence], 1, overflow_end, line_number, 2,
            split_circular_record(fields, 1, overflow_end, "2/2"),
        ))

    records.sort(key=lambda value: value[:5])
    with destination.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write("##gff-version 3\n")
        for header in headers:
            handle.write(f"{header}\n")
        for _sequence_order, _start, _end, _line_number, _part, line in records:
            handle.write(f"{line}\n")
    return counts, circular_origin_splits


def bgzip_and_index_gff(source: Path, destination: Path) -> None:
    try:
        import pysam
    except ImportError as exc:
        raise RuntimeError(
            "GFF3 BGZF compression and indexing require scripts/data/requirements-cyanobacteria.txt"
        ) from exc
    pysam.tabix_compress(str(source), str(destination), force=True)
    pysam.tabix_index(str(destination), preset="gff", force=True)


def bgzip_and_index_fasta(source: Path, destination: Path) -> None:
    try:
        import pysam
    except ImportError as exc:
        raise RuntimeError(
            "FASTA BGZF compression and indexing require scripts/data/requirements-cyanobacteria.txt"
        ) from exc
    pysam.tabix_compress(str(source), str(destination), force=True)
    pysam.faidx(str(destination))
    if not destination.with_suffix(destination.suffix + ".fai").is_file() or not destination.with_suffix(destination.suffix + ".gzi").is_file():
        raise ReleaseValidationError(f"{destination}: FASTA indexes were not created")


def deterministic_gzip(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as input_handle, destination.open("wb") as output_handle:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, mtime=0, fileobj=output_handle) as compressed:
            shutil.copyfileobj(input_handle, compressed, length=1024 * 1024)


def genome_catalog_entry(genome_id: str, config: dict, observed: dict | None = None) -> dict:
    assets = dict(ASSETS)
    experimental_config = config.get("experimentalTss")
    if not experimental_config:
        assets["experimentalTss"] = None
        assets["experimentalTssIndex"] = None
        assets["experimentalTssSource"] = None
    entry = {
        "id": genome_id,
        **{key: config[key] for key in [
            "identifierType", "organismName", "strain", "genomeSizeBp", "gcContent", "contigCount",
            "primarySequence", "defaultLocus", "candidatePeakCount", "candidatePeakStrands",
            "predictedPromoterCount", "predictedPromoterStrands", "annotation",
        ]},
        "assets": assets,
    }
    experimental_observed = (observed or {}).get("experimentalTss")
    entry["experimentalEvidence"] = None if not experimental_config else {
        "status": "experimentally_supported",
        "label": experimental_config["label"],
        "studyId": experimental_config["studyId"],
        "pmid": experimental_config["pmid"],
        "year": experimental_config["year"],
        "title": experimental_config["title"],
        "journal": experimental_config["journal"],
        "doi": experimental_config["doi"],
        "assemblyAccession": experimental_config["assemblyAccession"],
        "observationCount": (experimental_observed or {}).get("observationCount", experimental_config["expectedObservationCount"]),
        "uniqueTssCount": (experimental_observed or {}).get("uniqueTssCount", experimental_config["expectedUniqueTssCount"]),
        "crossStudySupportedTssCount": 0,
        "methodBoundary": experimental_config["methodBoundary"],
        "hfPath": experimental_config["hfPath"],
    }
    if observed:
        entry["validation"] = observed
    return entry


def build_genome(genome_id: str, config: dict, source_root: Path, reference_root: Path, output_root: Path) -> dict:
    source_reference = reference_root / genome_id / "reference.fa"
    source_fai = reference_root / genome_id / "reference.fa.fai"
    candidate_source = source_root / config["candidate"]
    prediction_source = source_root / config["prediction"]
    annotation_source = source_root / config["annotationSourcePath"]
    experimental_config = config.get("experimentalTss")
    experimental_source = source_root / experimental_config["path"] if experimental_config else None
    required_paths = [source_reference, source_fai, candidate_source, prediction_source, annotation_source]
    if experimental_source:
        required_paths.append(experimental_source)
    for path in required_paths:
        if not path.is_file():
            raise ReleaseValidationError(f"Missing source file: {path}")
    if experimental_source and sha256_file(experimental_source) != experimental_config["hfAssetSha256"]:
        raise ReleaseValidationError(f"{genome_id}: downloaded experimental TSS asset checksum differs from Hugging Face")

    sequences = read_fai(source_fai)
    if sum(length for _name, length in sequences) != config["genomeSizeBp"] or len(sequences) != config["contigCount"]:
        raise ReleaseValidationError(f"{genome_id}: FASTA size or contig count differs from the release contract")
    if config["primarySequence"] not in dict(sequences):
        raise ReleaseValidationError(f"{genome_id}: primary sequence is missing from the FASTA")

    destination = output_root / genome_id
    destination.mkdir(parents=True)
    (destination / "sources").mkdir()
    bgzip_and_index_fasta(source_reference, destination / ASSETS["fasta"])

    records, candidate_strands, expected_final = read_peak_records(candidate_source, dict(sequences))
    observed_candidate = candidate_strands["+"] + candidate_strands["-"]
    expected_candidate_strands = config["candidatePeakStrands"]
    if observed_candidate != config["candidatePeakCount"] or dict(plus=candidate_strands["+"], minus=candidate_strands["-"]) != expected_candidate_strands:
        raise ReleaseValidationError(f"{genome_id}: candidate peak counts do not match the release contract")
    write_bigwig(destination / ASSETS["promoterScoresPlus"], sequences, records, "+")
    write_bigwig(destination / ASSETS["promoterScoresMinus"], sequences, records, "-")

    final_set, final_strands = read_final_peak_set(prediction_source, dict(sequences))
    require_exact_final_subset(genome_id, expected_final, final_set)
    observed_final = len(final_set)
    if observed_final != config["predictedPromoterCount"] or dict(plus=final_strands["+"], minus=final_strands["-"]) != config["predictedPromoterStrands"]:
        raise ReleaseValidationError(f"{genome_id}: final promoter counts do not match the release contract")

    experimental_observed = None
    with tempfile.TemporaryDirectory(dir=destination) as temporary:
        temporary_root = Path(temporary)
        sorted_predictions = temporary_root / "predicted-promoters.gff3"
        sorted_annotations = temporary_root / "genome-annotations.gff3"
        prediction_counts, prediction_origin_splits = sorted_gff(prediction_source, sorted_predictions, sequences)
        annotation_counts, annotation_origin_splits = sorted_gff(annotation_source, sorted_annotations, sequences)
        if prediction_origin_splits:
            raise ReleaseValidationError(f"{genome_id}: promoter intervals unexpectedly cross a circular origin")
        if prediction_counts["promoter"] != observed_final:
            raise ReleaseValidationError(f"{genome_id}: normalized prediction count changed")
        for feature, expected in config["annotation"]["featureCounts"].items():
            if annotation_counts[feature] != expected:
                raise ReleaseValidationError(f"{genome_id}: {feature} annotation count differs from the release contract")
        bgzip_and_index_gff(sorted_predictions, destination / ASSETS["predictedPromoters"])
        bgzip_and_index_gff(sorted_annotations, destination / ASSETS["ncbiAnnotations"])
        if experimental_source:
            normalized_experimental = temporary_root / "experimentally-supported-tss.gff3"
            experimental_observed = normalize_experimental_tss_bed(
                experimental_source,
                normalized_experimental,
                sequences,
                experimental_config,
            )
            bgzip_and_index_gff(normalized_experimental, destination / ASSETS["experimentalTss"])

    deterministic_gzip(candidate_source, destination / ASSETS["candidateSource"])
    deterministic_gzip(prediction_source, destination / ASSETS["predictionSource"])
    deterministic_gzip(annotation_source, destination / ASSETS["annotationSource"])
    if experimental_source:
        deterministic_gzip(experimental_source, destination / ASSETS["experimentalTssSource"])

    observed = {
        "referenceSequences": [{"name": name, "length": length} for name, length in sequences],
        "candidatePeakCount": observed_candidate,
        "candidatePeakStrands": {"plus": candidate_strands["+"], "minus": candidate_strands["-"]},
        "predictedPromoterCount": observed_final,
        "predictedPromoterStrands": {"plus": final_strands["+"], "minus": final_strands["-"]},
        "finalSubsetRule": "candidate model score > 0.9",
        "finalSubsetVerified": True,
        "annotationFeatureCounts": dict(annotation_counts),
        "annotationCircularOriginSplitFeatures": annotation_origin_splits,
    }
    if experimental_observed:
        observed["experimentalTss"] = experimental_observed
    observed["predictionFeatureType"] = "promoter"
    observed["predictionWindow"] = PREDICTION_WINDOW
    metadata = genome_catalog_entry(genome_id, config, observed)
    metadata["coordinateSystems"] = {
        "sourceGff3": "1-based closed",
        "bigWig": "0-based half-open single-base intervals",
        "browserDisplay": "1-based coordinates",
    }
    metadata["evidenceBoundary"] = (
        "RAPPTOR promoter predictions are computational, not experimental TSS. "
        "Genome annotations provide context; they do not validate predictions."
    )
    metadata["sources"] = {
        "reference": {
            "originalFileName": source_reference.name,
            "releaseAsset": ASSETS["fasta"],
            "sha256": sha256_file(source_reference),
            "note": "Reference FASTA previously sequence-matched to all prediction and annotation inputs.",
        },
        "candidatePeaks": {
            "originalFileName": candidate_source.name,
            "releaseAsset": ASSETS["candidateSource"],
            "sha256": sha256_file(candidate_source),
            "selection": "smoothed promoter_peak records with model score > 0",
        },
        "finalPredictions": {
            "originalFileName": prediction_source.name,
            "releaseAsset": ASSETS["predictionSource"],
            "sha256": sha256_file(prediction_source),
            "selection": "100 bp promoter intervals spanning 80 bp upstream and 20 bp downstream of each model-score peak > 0.9",
            "featureType": "promoter",
            "anchorAttribute": PREDICTION_WINDOW["anchorAttribute"],
        },
        "genomeAnnotation": {
            "originalFileName": annotation_source.name,
            "releaseAsset": ASSETS["annotationSource"],
            "sha256": sha256_file(annotation_source),
            "source": config["annotation"]["label"],
        },
    }
    if experimental_source:
        metadata["sources"]["experimentalTss"] = {
            "originalFileName": experimental_source.name,
            "releaseAsset": ASSETS["experimentalTssSource"],
            "normalizedTrack": ASSETS["experimentalTss"],
            "sha256": sha256_file(experimental_source),
            "huggingFacePath": experimental_config["hfPath"],
            "sourceManifestSha256": experimental_config["sourceManifestSha256"],
            "studyId": experimental_config["studyId"],
            "pmid": experimental_config["pmid"],
            "coordinateConversion": "BED 0-based half-open single-base intervals to GFF3 1-based closed points",
            "seqidNormalization": f"removed exact prefix {experimental_config['seqidPrefix']}",
        }
    (destination / ASSETS["metadata"]).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


def release_catalog(genomes: list[dict], generated_at: str) -> dict:
    return {
        "releaseId": RELEASE_ID,
        "generatedAt": generated_at,
        "title": "RAPPTOR cyanobacterial promoter predictions",
        "description": "Three genomes with RAPPTOR promoter predictions and genome annotations.",
        "assetBaseUrl": HF_ASSET_BASE,
        "manifest": "manifest.tsv",
        "checksums": "checksums.sha256",
        "releaseMetadata": "release.json",
        "totalGenomes": len(genomes),
        "totalCandidatePeaks": sum(genome["candidatePeakCount"] for genome in genomes),
        "totalPredictedPromoters": sum(genome["predictedPromoterCount"] for genome in genomes),
        "totalExperimentallySupportedGenomes": sum(1 for genome in genomes if genome["experimentalEvidence"]),
        "totalExperimentalTssObservations": sum(
            genome["experimentalEvidence"]["observationCount"]
            for genome in genomes
            if genome["experimentalEvidence"]
        ),
        "genomes": genomes,
        "predictionWindow": PREDICTION_WINDOW,
    }


def write_manifests(root: Path) -> None:
    files = sorted(
        path for path in root.rglob("*")
        if path.is_file() and path.name not in {"manifest.tsv", "checksums.sha256"}
    )
    rows = ["path\tbytes\tsha256"]
    checksums = []
    for path in files:
        relative = path.relative_to(root).as_posix()
        digest = sha256_file(path)
        rows.append(f"{relative}\t{path.stat().st_size}\t{digest}")
        checksums.append(f"{digest}  {relative}")
    (root / "manifest.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    (root / "checksums.sha256").write_text("\n".join(checksums) + "\n", encoding="utf-8")


def validate_release(root: Path) -> dict:
    release_path = root / "release.json"
    if not release_path.is_file():
        raise ReleaseValidationError(f"{root}: release.json is missing")
    release = json.loads(release_path.read_text(encoding="utf-8"))
    if (
        release["totalGenomes"] != 3
        or release["totalCandidatePeaks"] != 2_609_318
        or release["totalPredictedPromoters"] != 112_862
        or release.get("totalExperimentallySupportedGenomes") != 1
        or release.get("totalExperimentalTssObservations") != 13_705
    ):
        raise ReleaseValidationError("Release totals do not match the fixed acceptance contract")
    observed_genomes = {genome["id"]: genome for genome in release.get("genomes", [])}
    if set(observed_genomes) != set(GENOMES):
        raise ReleaseValidationError("Release genome identifiers do not match the fixed acceptance contract")
    for genome_id, config in GENOMES.items():
        genome = observed_genomes[genome_id]
        if genome.get("candidatePeakCount") != config["candidatePeakCount"] or genome.get("predictedPromoterCount") != config["predictedPromoterCount"]:
            raise ReleaseValidationError(f"{genome_id}: release counts do not match the fixed acceptance contract")
        if genome.get("validation", {}).get("finalSubsetVerified") is not True:
            raise ReleaseValidationError(f"{genome_id}: final score > 0.9 subset verification is missing")
        if genome.get("validation", {}).get("predictionWindow") != PREDICTION_WINDOW:
            raise ReleaseValidationError(f"{genome_id}: 100 bp prediction window metadata is missing")
        if bool(genome.get("experimentalEvidence")) != (genome_id == "ASM970v1"):
            raise ReleaseValidationError(f"{genome_id}: experimental evidence does not match the release contract")
    manifest_rows = (root / "manifest.tsv").read_text(encoding="utf-8").splitlines()
    if not manifest_rows or manifest_rows[0] != "path\tbytes\tsha256":
        raise ReleaseValidationError("Invalid release manifest header")
    manifest: dict[str, tuple[int, str]] = {}
    for line in manifest_rows[1:]:
        relative, size, digest = line.split("\t")
        relative_path = Path(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts or relative in manifest:
            raise ReleaseValidationError(f"Invalid or duplicate manifest path: {relative}")
        path = root / relative_path
        if not path.is_file() or path.stat().st_size != int(size) or sha256_file(path) != digest:
            raise ReleaseValidationError(f"Manifest verification failed for {relative}")
        manifest[relative] = (int(size), digest)
    expected_files = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path.name not in {"manifest.tsv", "checksums.sha256"}
    }
    if set(manifest) != expected_files:
        raise ReleaseValidationError("Manifest does not describe the complete release file set")
    checksum_lines = (root / "checksums.sha256").read_text(encoding="utf-8").splitlines()
    expected_checksums = [f"{digest}  {relative}" for relative, (_size, digest) in manifest.items()]
    if checksum_lines != expected_checksums:
        raise ReleaseValidationError("checksums.sha256 does not match manifest.tsv")
    return {"files": len(manifest), "bytes": sum(size for size, _digest in manifest.values())}


def release_generated_at(project_root: Path) -> str:
    generated = project_root / "src" / "generated" / "cyanobacteria-release.json"
    if generated.is_file():
        try:
            current = json.loads(generated.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ReleaseValidationError(f"Invalid generated release JSON: {generated}") from error
        if current.get("releaseId") == RELEASE_ID and isinstance(current.get("generatedAt"), str):
            return current["generatedAt"]
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build(project_root: Path, source_root: Path, reference_root: Path, release_id: str, force: bool) -> Path:
    if release_id != RELEASE_ID:
        raise ReleaseValidationError(f"This release contract is fixed to {RELEASE_ID}")
    release_parent = project_root / ".data" / "cyanobacteria" / "releases"
    destination = release_parent / release_id
    work_parent = project_root / ".data" / "cyanobacteria" / "work"
    release_parent.mkdir(parents=True, exist_ok=True)
    work_parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and not force:
        raise ReleaseValidationError(f"Release already exists: {destination} (use --force)")
    with tempfile.TemporaryDirectory(prefix=f"{release_id}-", dir=work_parent) as temporary:
        staging = Path(temporary) / "release"
        staging.mkdir()
        genomes = []
        for genome_id, config in GENOMES.items():
            print(f"Building {genome_id}...", flush=True)
            genomes.append(build_genome(genome_id, config, source_root, reference_root, staging))
        generated_at = release_generated_at(project_root)
        catalog = release_catalog(genomes, generated_at)
        (staging / "release.json").write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
        write_manifests(staging)
        summary = validate_release(staging)
        if destination.exists():
            if destination.parent.resolve() != release_parent.resolve():
                raise ReleaseValidationError("Refusing to replace a release outside the expected directory")
            shutil.rmtree(destination)
        shutil.move(str(staging), str(destination))
    generated = project_root / "src" / "generated" / "cyanobacteria-release.json"
    generated.write_text((destination / "release.json").read_text(encoding="utf-8"), encoding="utf-8")
    print(f"Built {destination}: {summary['files']} files, {summary['bytes']} bytes", flush=True)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--reference-root", type=Path)
    parser.add_argument("--release", default=RELEASE_ID)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--validate-only", type=Path)
    args = parser.parse_args()
    project_root = args.project_root.resolve()
    if args.validate_only:
        summary = validate_release(args.validate_only.resolve())
        print(json.dumps(summary))
        return 0
    source_root = (args.source_root or project_root / ".data" / "cyanobacteria").resolve()
    reference_root = (
        args.reference_root
        or project_root.parent / "SeqEdge" / ".data" / "legacy" / "real-genomes"
    ).resolve()
    build(project_root, source_root, reference_root, args.release, args.force)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ReleaseValidationError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2)
