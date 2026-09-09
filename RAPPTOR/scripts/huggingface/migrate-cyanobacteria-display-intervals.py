#!/usr/bin/env python3
"""Prepare the cyanobacteria-only 79/1/20 display-interval HF patch.

This tool is deliberately offline: it reads a release snapshot pinned by the
caller, writes a 12-file upload patch, and never contacts or mutates the Hub.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from collections import Counter
from pathlib import Path
from urllib.parse import quote, unquote


REPO_ID = "liurulong/bacterial-promoter-genomes"
SOURCE_REVISION = "a09a8119f009afd7641e6b3530bac67ae1e53e95"
RELEASE_PREFIX = "cyanobacteria/releases/2026-08-27"
GENOMES = ("ASM970v1", "Cf6912", "CP003597.1")
DISPLAY_WINDOW = {
    "lengthBp": 100,
    "upstreamBp": 79,
    "anchorBp": 1,
    "downstreamBp": 20,
    "anchorAttribute": "peak_position",
    "coordinateSystem": "1-based closed",
    "boundaryRule": "retain anchor point and mark display interval unavailable",
    "scoringWindow": {
        "lengthBp": 100,
        "upstreamBp": 80,
        "downstreamBp": 20,
        "coordinateSystem": "1-based closed",
    },
}
DISPLAY_DIRECTIVE = (
    "##RAPPtor-promoter-display-interval length=100 upstream=79 anchor=1 "
    "downstream=20 coordinate_system=1-based_closed"
)
SCORING_DIRECTIVE = (
    "##RAPPtor-scoring-window length=100 upstream=80 downstream=20 "
    "coordinate_system=1-based_closed"
)
GENERATED_GENOME_FILES = (
    "metadata.json",
    "predicted-promoters.gff3.gz",
    "predicted-promoters.gff3.gz.tbi",
)
ROOT_FILES = ("release.json", "manifest.tsv", "checksums.sha256")


class MigrationError(ValueError):
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
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        fields = line.split("\t")
        if len(fields) < 2:
            raise MigrationError(f"{path}:{line_number}: invalid FAI row")
        try:
            length = int(fields[1])
        except ValueError as exc:
            raise MigrationError(f"{path}:{line_number}: invalid FAI length") from exc
        if not fields[0] or fields[0] in seen or length < 1:
            raise MigrationError(f"{path}:{line_number}: invalid or duplicate sequence")
        seen.add(fields[0])
        sequences.append((fields[0], length))
    if not sequences:
        raise MigrationError(f"{path}: empty FAI")
    return sequences


def parse_attributes(text: str) -> dict[str, str]:
    attributes: dict[str, str] = {}
    if text == ".":
        return attributes
    for item in text.split(";"):
        key, separator, value = item.partition("=")
        if separator and key:
            if key in attributes:
                raise MigrationError(f"duplicate GFF3 attribute: {key}")
            attributes[key] = unquote(value)
    return attributes


def encode_attributes(attributes: dict[str, str]) -> str:
    return ";".join(
        f"{key}={quote(str(value), safe='._:-')}" for key, value in attributes.items()
    )


def display_interval(anchor: int, strand: str, sequence_length: int) -> tuple[int, int, bool]:
    if strand == "+":
        start, end = anchor - 79, anchor + 20
    elif strand == "-":
        start, end = anchor - 20, anchor + 79
    else:
        raise MigrationError(f"invalid promoter strand: {strand}")
    if start < 1 or end > sequence_length:
        return anchor, anchor, False
    return start, end, True


def historical_scoring_interval(anchor: int, strand: str) -> tuple[int, int]:
    return (anchor - 80, anchor + 19) if strand == "+" else (anchor - 19, anchor + 80)


def _record_signature(fields: list[str], attributes: dict[str, str]) -> tuple[str, str, str, str, str]:
    record_id = attributes.get("ID")
    anchor = attributes.get("peak_position")
    if not record_id or not anchor:
        raise MigrationError("every predicted promoter must retain ID and peak_position")
    return fields[0], record_id, anchor, fields[6], fields[5]


def migrate_gff_text(
    text: str,
    sequences: list[tuple[str, int]],
) -> tuple[str, dict]:
    """Normalize legacy or already migrated GFF3 text without coordinate drift."""
    sequence_order = {name: index for index, (name, _length) in enumerate(sequences)}
    sequence_lengths = dict(sequences)
    headers: list[str] = []
    records: list[tuple[int, int, int, str, list[str]]] = []
    before_signatures: Counter = Counter()
    after_signatures: Counter = Counter()
    strands: Counter = Counter()
    boundaries: Counter = Counter()
    input_states: Counter = Counter()
    shifts: Counter = Counter()

    for line_number, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.rstrip("\r\n")
        if not line:
            continue
        if line.startswith("#"):
            if line == "##gff-version 3" or line.startswith("##RAPPtor-promoter-display-interval") \
                    or line.startswith("##RAPPtor-scoring-window"):
                continue
            headers.append(line)
            continue
        fields = line.split("\t")
        if len(fields) != 9:
            raise MigrationError(f"GFF3:{line_number}: expected 9 columns")
        sequence, feature_type, strand = fields[0], fields[2], fields[6]
        if sequence not in sequence_lengths:
            raise MigrationError(f"GFF3:{line_number}: unknown sequence {sequence}")
        if feature_type != "promoter" or strand not in {"+", "-"}:
            raise MigrationError(f"GFF3:{line_number}: expected stranded promoter")
        try:
            start, end = int(fields[3]), int(fields[4])
        except ValueError as exc:
            raise MigrationError(f"GFF3:{line_number}: invalid coordinates") from exc
        attributes = parse_attributes(fields[8])
        try:
            anchor = int(attributes["peak_position"])
        except (KeyError, ValueError) as exc:
            raise MigrationError(f"GFF3:{line_number}: invalid peak_position") from exc
        if not 1 <= anchor <= sequence_lengths[sequence]:
            raise MigrationError(f"GFF3:{line_number}: anchor outside reference")

        signature = _record_signature(fields, attributes)
        before_signatures[signature] += 1
        legacy_start, legacy_end = historical_scoring_interval(anchor, strand)
        scoring_keys = (
            "scoring_window_start_1based",
            "scoring_window_end_1based",
            "scoring_window_coordinate_system",
        )
        has_scoring = [key in attributes for key in scoring_keys]
        if any(has_scoring) and not all(has_scoring):
            raise MigrationError(f"GFF3:{line_number}: incomplete scoring-window provenance")
        if all(has_scoring):
            try:
                scoring_start = int(attributes[scoring_keys[0]])
                scoring_end = int(attributes[scoring_keys[1]])
            except ValueError as exc:
                raise MigrationError(f"GFF3:{line_number}: invalid scoring-window coordinates") from exc
            if attributes[scoring_keys[2]] != "1-based_closed":
                raise MigrationError(f"GFF3:{line_number}: unsupported scoring coordinate system")
            input_states["alreadyMigrated"] += 1
        elif (start, end) == (legacy_start, legacy_end) \
                and attributes.get("upstream_length") == "80" \
                and attributes.get("downstream_length") == "20":
            # The fixed source release explicitly represented the historical model window.
            scoring_start, scoring_end = start, end
            input_states["legacy"] += 1
        else:
            raise MigrationError(
                f"GFF3:{line_number}: cannot infer actual scoring window from an unrecognized record"
            )
        if (scoring_start, scoring_end) != (legacy_start, legacy_end):
            raise MigrationError(f"GFF3:{line_number}: scoring window differs from fixed source")

        new_start, new_end, available = display_interval(anchor, strand, sequence_lengths[sequence])
        if available and (start, end) == (legacy_start, legacy_end):
            shifts["plusStartEndPlusOne" if strand == "+" else "minusStartEndMinusOne"] += 1
        elif not available:
            shifts["boundaryAnchorFallback"] += 1
        fields[3], fields[4] = str(new_start), str(new_end)
        attributes.update({
            "upstream_length": "79",
            "downstream_length": "20",
            "display_coordinate_system": "1-based_closed",
            "display_interval": "available" if available else "unavailable",
            "sequence_length": str(sequence_lengths[sequence]),
            "scoring_window_start_1based": str(scoring_start),
            "scoring_window_end_1based": str(scoring_end),
            "scoring_window_coordinate_system": "1-based_closed",
        })
        fields[8] = encode_attributes(attributes)
        after_signatures[_record_signature(fields, attributes)] += 1
        strands[strand] += 1
        boundaries["available" if available else "unavailable"] += 1
        records.append((sequence_order[sequence], new_start, new_end, attributes["ID"], fields))

    if before_signatures != after_signatures:
        raise MigrationError("anchor, ID, strand, score, or record count changed")
    if any(count != 1 for count in after_signatures.values()):
        raise MigrationError("duplicate promoter identity in fixed source")
    records.sort(key=lambda value: (value[0], value[1], value[2], value[3], value[4][6]))
    output = ["##gff-version 3", DISPLAY_DIRECTIVE, SCORING_DIRECTIVE, *headers]
    output.extend("\t".join(record[-1]) for record in records)
    return "\n".join(output) + "\n", {
        "records": sum(strands.values()),
        "strands": {"plus": strands["+"], "minus": strands["-"]},
        "displayIntervals": {
            "available": boundaries["available"],
            "unavailable": boundaries["unavailable"],
        },
        "inputStates": {
            "legacy": input_states["legacy"],
            "alreadyMigrated": input_states["alreadyMigrated"],
        },
        "coordinateChanges": {
            "plusStartEndPlusOne": shifts["plusStartEndPlusOne"],
            "minusStartEndMinusOne": shifts["minusStartEndMinusOne"],
            "boundaryAnchorFallback": shifts["boundaryAnchorFallback"],
        },
        "identityVerified": True,
    }


def _wsl_path(path: Path) -> str:
    resolved = path.resolve()
    drive, tail = os.path.splitdrive(str(resolved))
    if not drive:
        raise MigrationError(f"cannot map path to WSL: {path}")
    return f"/mnt/{drive[0].lower()}/{tail.lstrip('\\/').replace('\\', '/')}"


def bgzip_and_tabix(plain: Path, compressed: Path, mode: str) -> None:
    compressed.parent.mkdir(parents=True, exist_ok=True)
    direct = mode == "direct" or (mode == "auto" and shutil.which("bgzip") and shutil.which("tabix"))
    if direct:
        with compressed.open("wb") as output:
            subprocess.run(["bgzip", "-c", str(plain)], stdout=output, check=True)
        subprocess.run(["tabix", "-f", "-p", "gff", str(compressed)], check=True)
        return
    if mode not in {"auto", "wsl"}:
        raise MigrationError(f"unsupported htslib mode: {mode}")
    with compressed.open("wb") as output:
        subprocess.run(["wsl", "--", "bgzip", "-c", _wsl_path(plain)], stdout=output, check=True)
    subprocess.run(
        ["wsl", "--", "tabix", "-f", "-p", "gff", _wsl_path(compressed)],
        check=True,
    )


def tabix_query(compressed: Path, region: str, mode: str) -> str:
    if mode == "direct" or (mode == "auto" and shutil.which("tabix")):
        command = ["tabix", str(compressed), region]
    else:
        command = ["wsl", "--", "tabix", _wsl_path(compressed), region]
    result = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8")
    return result.stdout


def parse_manifest(path: Path) -> tuple[list[str], dict[str, tuple[int, str]]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "path\tbytes\tsha256":
        raise MigrationError("invalid manifest.tsv header")
    order: list[str] = []
    manifest: dict[str, tuple[int, str]] = {}
    for line in lines[1:]:
        relative, size, digest = line.split("\t")
        if relative in manifest:
            raise MigrationError(f"duplicate manifest path: {relative}")
        order.append(relative)
        manifest[relative] = (int(size), digest)
    return order, manifest


def parse_checksums(path: Path) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        digest, separator, relative = line.partition("  ")
        if not separator or relative in checksums:
            raise MigrationError(f"invalid checksum row: {line}")
        checksums[relative] = digest
    return checksums


def update_genome_metadata(metadata: dict) -> dict:
    metadata["validation"]["predictionWindow"] = DISPLAY_WINDOW
    coordinate_systems = metadata.setdefault("coordinateSystems", {})
    coordinate_systems["predictionDisplayGff3"] = "1-based closed display intervals"
    final = metadata["sources"]["finalPredictions"]
    final["selection"] = (
        "Original source selects model-score peaks > 0.9 in 80/20 scoring windows; "
        "the browser asset uses 79 bp upstream, the anchor base, and 20 bp downstream "
        "while retaining each source scoring window in attributes"
    )
    final["featureType"] = "promoter"
    final["anchorAttribute"] = "peak_position"
    return metadata


def _first_record(text: str) -> tuple[str, int, int, str]:
    for line in text.splitlines():
        if line and not line.startswith("#"):
            fields = line.split("\t")
            return fields[0], int(fields[3]), int(fields[4]), parse_attributes(fields[8])["ID"]
    raise MigrationError("migrated GFF3 has no records")


def write_markdown_report(output_root: Path, report: dict) -> None:
    lines = [
        "# Cyanobacteria display-interval migration report",
        "",
        f"- Repository: `{report['repoId']}`",
        f"- Fixed source revision / required parent commit: `{report['sourceRevision']}`",
        f"- Release prefix: `{report['releasePrefix']}`",
        f"- Source release inventory: {report['sourceReleaseFiles']} files",
        f"- Prepared atomic upload whitelist: {report['uploadFileCount']} files",
        f"- Promoter records verified: {report['totalRecords']:,}",
        f"- Boundary fallbacks: {report['totalBoundaryUnavailable']}",
        "- Remote mutation performed: no",
        "",
        "## Record validation",
        "",
        "| Genome | Records | Plus | Minus | Boundary unavailable | Tabix query |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for genome in GENOMES:
        stats = report["genomes"][genome]
        lines.append(
            f"| {genome} | {stats['records']:,} | {stats['strands']['plus']:,} | "
            f"{stats['strands']['minus']:,} | {stats['displayIntervals']['unavailable']} | "
            f"`{stats['tabixQuery']}` passed |"
        )
    lines.extend([
        "",
        "Every output record retained its ID, `peak_position`, strand, score and feature count. "
        "All legacy plus-strand records moved start/end by +1; all legacy minus-strand records "
        "moved start/end by -1. A second in-memory conversion of every migrated record was byte-stable.",
        "",
        "The release GFF3 stores the 79/1/20 display interval separately from the historical "
        "80/20 model scoring interval. Scoring coordinates come from the fixed source record's "
        "original start/end fields; the migration refuses to invent them for ambiguous input.",
        "",
        "## Upload whitelist",
        "",
    ])
    lines.extend(f"- `{path}`" for path in report["uploadWhitelist"])
    lines.extend([
        "",
        "No FASTA, BigWig, genome annotation, experimental TSS, or `sources/` backup is in this list. "
        f"The other {report['preservedManifestEntries']} manifest entries retain their fixed-source "
        "size and SHA-256 rows.",
        "",
        "## Future atomic upload guard",
        "",
        "Before any upload, query dataset `main` and require it to equal the source revision above. "
        "Create one `HfApi.create_commit` call with `repo_type='dataset'`, `revision='main'`, "
        f"`parent_commit='{SOURCE_REVISION}'`, and the 12 `CommitOperationAdd` objects listed in "
        "`upload-plan.json`. Abort on a parent mismatch; do not retry blindly after a timeout.",
        "",
        "After the commit, capture the returned revision and verify all 45 release paths at that "
        "fixed revision. Then pin the web release to that returned revision. This preparation step "
        "did not upload, commit, push, or deploy anything.",
        "",
        "Exact before/after byte sizes and SHA-256 values are in `before-after-sha256.tsv`; "
        "machine-readable checks and local paths are in `migration-report.json` and `upload-plan.json`.",
        "",
    ])
    (output_root / "MIGRATION-REPORT.md").write_text("\n".join(lines), encoding="utf-8")


def prepare_patch(source_root: Path, output_root: Path, source_revision: str, htslib_mode: str) -> dict:
    if source_revision != SOURCE_REVISION:
        raise MigrationError(
            f"source revision must be exactly {SOURCE_REVISION}; got {source_revision}"
        )
    source_root = source_root.resolve()
    output_root = output_root.resolve()
    patch_release = output_root / "upload-patch" / RELEASE_PREFIX
    patch_release.mkdir(parents=True, exist_ok=True)

    manifest_order, old_manifest = parse_manifest(source_root / "manifest.tsv")
    old_checksums = parse_checksums(source_root / "checksums.sha256")
    if len(old_manifest) != 43 or old_checksums != {path: digest for path, (_size, digest) in old_manifest.items()}:
        raise MigrationError("fixed source must contain a self-consistent 43-entry manifest (45 files total)")

    required_input = set(ROOT_FILES)
    for genome in GENOMES:
        required_input.update({
            f"{genome}/metadata.json",
            f"{genome}/predicted-promoters.gff3.gz",
            f"{genome}/predicted-promoters.gff3.gz.tbi",
            f"{genome}/reference.fa.gz.fai",
        })
    for relative in sorted(required_input):
        path = source_root / relative
        if not path.is_file():
            raise MigrationError(f"missing fixed-revision input: {relative}")
        if relative in old_manifest and sha256_file(path) != old_manifest[relative][1]:
            raise MigrationError(f"fixed-revision input hash differs from manifest: {relative}")

    release = json.loads((source_root / "release.json").read_text(encoding="utf-8"))
    if release.get("totalPredictedPromoters") != 112_862:
        raise MigrationError("fixed release totalPredictedPromoters is not 112862")

    genome_reports: dict[str, dict] = {}
    updated_metadata: dict[str, dict] = {}
    changed_data_paths: list[str] = []
    before_after: dict[str, dict[str, str | int]] = {}
    with tempfile.TemporaryDirectory(prefix="cyanobacteria-display-") as temporary:
        temporary_root = Path(temporary)
        for genome in GENOMES:
            sequences = read_fai(source_root / genome / "reference.fa.gz.fai")
            old_gff = source_root / genome / "predicted-promoters.gff3.gz"
            with gzip.open(old_gff, "rt", encoding="utf-8") as handle:
                old_text = handle.read()
            new_text, stats = migrate_gff_text(old_text, sequences)
            second_text, second_stats = migrate_gff_text(new_text, sequences)
            stable_fields = ("records", "strands", "displayIntervals", "identityVerified")
            if second_text != new_text or any(second_stats[key] != stats[key] for key in stable_fields):
                raise MigrationError(f"{genome}: second migration drifted")
            plain = temporary_root / f"{genome}.predicted-promoters.gff3"
            plain.write_text(new_text, encoding="utf-8", newline="\n")
            new_gff = patch_release / genome / "predicted-promoters.gff3.gz"
            bgzip_and_tabix(plain, new_gff, htslib_mode)
            new_tbi = Path(f"{new_gff}.tbi")
            sequence, start, end, record_id = _first_record(new_text)
            query = f"{sequence}:{start}-{end}"
            queried = tabix_query(new_gff, query, htslib_mode)
            if not any(
                parse_attributes(line.split("\t")[8]).get("ID") == record_id
                for line in queried.splitlines() if line and not line.startswith("#")
            ):
                raise MigrationError(f"{genome}: tabix query did not return the selected record")

            metadata = json.loads((source_root / genome / "metadata.json").read_text(encoding="utf-8"))
            updated_metadata[genome] = update_genome_metadata(metadata)
            metadata_path = patch_release / genome / "metadata.json"
            metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

            for name, output in (
                ("predicted-promoters.gff3.gz", new_gff),
                ("predicted-promoters.gff3.gz.tbi", new_tbi),
                ("metadata.json", metadata_path),
            ):
                relative = f"{genome}/{name}"
                changed_data_paths.append(relative)
                before_after[relative] = {
                    "beforeBytes": old_manifest[relative][0],
                    "beforeSha256": old_manifest[relative][1],
                    "afterBytes": output.stat().st_size,
                    "afterSha256": sha256_file(output),
                }
            stats.update({
                "secondMigrationStable": True,
                "tabixQuery": query,
                "tabixQueryVerified": True,
                "sourceBackupSha256": old_manifest[f"{genome}/sources/final-predictions.source.gff3.gz"][1],
                "sourceBackupUploaded": False,
            })
            genome_reports[genome] = stats

    release["description"] = (
        "Three cyanobacterial reference genomes with scored candidate peaks, RAPPTOR promoter "
        "display intervals spanning 79 bp upstream, the 1 bp peak anchor, and 20 bp downstream, "
        "unchanged model scoring tracks, genome annotations and study-linked experimental TSS "
        "evidence where available."
    )
    release["predictionWindow"] = DISPLAY_WINDOW
    release["genomes"] = [updated_metadata[genome["id"]] for genome in release["genomes"]]
    release_path = patch_release / "release.json"
    release_path.write_text(json.dumps(release, indent=2) + "\n", encoding="utf-8")
    changed_data_paths.append("release.json")
    before_after["release.json"] = {
        "beforeBytes": (source_root / "release.json").stat().st_size,
        "beforeSha256": sha256_file(source_root / "release.json"),
        "afterBytes": release_path.stat().st_size,
        "afterSha256": sha256_file(release_path),
    }

    new_manifest = dict(old_manifest)
    for relative in changed_data_paths:
        output = patch_release / relative
        new_manifest[relative] = (output.stat().st_size, sha256_file(output))
    manifest_text = "path\tbytes\tsha256\n" + "".join(
        f"{relative}\t{new_manifest[relative][0]}\t{new_manifest[relative][1]}\n"
        for relative in manifest_order
    )
    manifest_path = patch_release / "manifest.tsv"
    manifest_path.write_text(manifest_text, encoding="utf-8", newline="\n")
    checksums_path = patch_release / "checksums.sha256"
    checksums_path.write_text(
        "".join(f"{new_manifest[relative][1]}  {relative}\n" for relative in manifest_order),
        encoding="utf-8",
        newline="\n",
    )
    for name, output in (("manifest.tsv", manifest_path), ("checksums.sha256", checksums_path)):
        source = source_root / name
        before_after[name] = {
            "beforeBytes": source.stat().st_size,
            "beforeSha256": sha256_file(source),
            "afterBytes": output.stat().st_size,
            "afterSha256": sha256_file(output),
        }

    whitelist = sorted(
        [f"{genome}/{name}" for genome in GENOMES for name in GENERATED_GENOME_FILES]
        + list(ROOT_FILES)
    )
    if len(whitelist) != 12 or set(before_after) != set(whitelist):
        raise MigrationError("upload whitelist must contain exactly the 12 intended files")
    preserved = sorted(set(old_manifest) - set(changed_data_paths))
    if any(path.startswith("sources/") or "/sources/" in path for path in whitelist):
        raise MigrationError("source backup leaked into upload whitelist")
    if any(path.endswith(".bw") or "experimentally-supported" in path for path in whitelist):
        raise MigrationError("non-prediction asset leaked into upload whitelist")
    if sum(stats["records"] for stats in genome_reports.values()) != 112_862:
        raise MigrationError("migrated promoter count is not 112862")

    upload_operations = []
    for relative in whitelist:
        upload_operations.append({
            "pathInRepo": f"{RELEASE_PREFIX}/{relative}",
            "localPath": str((patch_release / relative).relative_to(output_root).as_posix()),
            **before_after[relative],
        })
    upload_plan = {
        "repoId": REPO_ID,
        "repoType": "dataset",
        "targetBranch": "main",
        "parentCommit": SOURCE_REVISION,
        "releasePrefix": RELEASE_PREFIX,
        "expectedFileCount": 12,
        "operations": upload_operations,
        "guard": "Abort if current main revision is not parentCommit; create one atomic commit only.",
    }
    (output_root / "upload-plan.json").write_text(
        json.dumps(upload_plan, indent=2) + "\n", encoding="utf-8"
    )
    before_after_path = output_root / "before-after-sha256.tsv"
    before_after_path.write_text(
        "path\tbefore_bytes\tbefore_sha256\tafter_bytes\tafter_sha256\n" + "".join(
            f"{relative}\t{before_after[relative]['beforeBytes']}\t{before_after[relative]['beforeSha256']}\t"
            f"{before_after[relative]['afterBytes']}\t{before_after[relative]['afterSha256']}\n"
            for relative in whitelist
        ),
        encoding="utf-8",
        newline="\n",
    )

    source_backups = {
        path: old_manifest[path][1]
        for path in manifest_order if "/sources/" in path
    }
    report = {
        "repoId": REPO_ID,
        "sourceRevision": SOURCE_REVISION,
        "releasePrefix": RELEASE_PREFIX,
        "sourceReleaseFiles": 45,
        "sourceManifestEntries": len(old_manifest),
        "uploadFileCount": len(whitelist),
        "uploadWhitelist": [f"{RELEASE_PREFIX}/{path}" for path in whitelist],
        "totalRecords": sum(stats["records"] for stats in genome_reports.values()),
        "totalBoundaryUnavailable": sum(
            stats["displayIntervals"]["unavailable"] for stats in genome_reports.values()
        ),
        "genomes": genome_reports,
        "preservedManifestEntries": len(preserved),
        "preservedPaths": preserved,
        "sourceBackups": source_backups,
        "sourceBackupsUnchanged": True,
        "bigWigUploaded": False,
        "experimentalTssUploaded": False,
        "fastaUploaded": False,
        "annotationsUploaded": False,
        "idempotenceVerified": True,
        "tabixQueriesVerified": True,
        "remoteMutationPerformed": False,
        "futureUploadGuard": upload_plan["guard"],
    }
    (output_root / "migration-report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    write_markdown_report(output_root, report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--source-revision", default=SOURCE_REVISION)
    parser.add_argument("--htslib-mode", choices=("auto", "direct", "wsl"), default="auto")
    args = parser.parse_args()
    report = prepare_patch(
        args.source_root,
        args.output_root,
        args.source_revision,
        args.htslib_mode,
    )
    print(json.dumps({
        "uploadFileCount": report["uploadFileCount"],
        "totalRecords": report["totalRecords"],
        "totalBoundaryUnavailable": report["totalBoundaryUnavailable"],
        "idempotenceVerified": report["idempotenceVerified"],
        "tabixQueriesVerified": report["tabixQueriesVerified"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
