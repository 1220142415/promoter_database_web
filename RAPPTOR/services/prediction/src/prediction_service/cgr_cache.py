from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
from contextlib import contextmanager
from functools import lru_cache
from datetime import datetime, timezone
from pathlib import Path

import torch

from rapptor.cgr.converter import generate_cgr_from_fasta

from .cgr import load_cgr_tensor
from .config import SETTINGS


ACCESSION_RE = re.compile(r"GC[FA]_[0-9]{9}\.[0-9]+")
VERSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")


class ReferenceCgrNotFound(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cache_dir(accession: str, *, root: Path, version: str) -> Path:
    if not ACCESSION_RE.fullmatch(accession) or not VERSION_RE.fullmatch(version):
        raise ReferenceCgrNotFound("Reference CGR is unavailable.")
    root = Path(root).resolve()
    result = (root / accession / version).resolve()
    if not result.is_relative_to(root):
        raise ReferenceCgrNotFound("Reference CGR is unavailable.")
    return result


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _publish(temp_dir: Path, target_dir: Path) -> None:
    if not target_dir.exists():
        os.replace(temp_dir, target_dir)
        return
    backup = target_dir.with_name(f".{target_dir.name}.old-{uuid.uuid4().hex}")
    os.replace(target_dir, backup)
    try:
        os.replace(temp_dir, target_dir)
    except Exception:
        os.replace(backup, target_dir)
        raise
    shutil.rmtree(backup, ignore_errors=True)


def _write_manifest(
    directory: Path, accession: str, fasta_sha256: str, png_sha256: str, version: str,
) -> None:
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "accession": accession,
                "fastaSha256": fasta_sha256,
                "cgrPngSha256": png_sha256,
                "resolution": 128,
                "cgrVersion": version,
                "generatedAt": _utc_now(),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def write_cache_entry(
    accession: str,
    fasta_path: Path,
    fasta_sha256: str,
    *,
    root: Path,
    version: str,
) -> dict:
    target_dir = cache_dir(accession, root=root, version=version)
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{version}.tmp-", dir=target_dir.parent))
    try:
        matrix_path = temp_dir / "cgr.npy"
        png_path = temp_dir / "cgr.png"
        generate_cgr_from_fasta(
            fasta_path,
            matrix_path,
            image_path=png_path,
            resolution=128,
            raw_counts=False,
        )
        load_cgr_tensor(png_path, expected_size=128)
        matrix_path.unlink()
        _write_manifest(temp_dir, accession, fasta_sha256, sha256_file(png_path), version)
        _publish(temp_dir, target_dir)
        temp_dir = None
        return validate_reference_cgr(
            accession,
            root=root,
            version=version,
            expected_fasta_sha256=fasta_sha256,
        )
    finally:
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)


def write_uploaded_cgr_entry(
    accession: str,
    source_png: Path,
    fasta_sha256: str,
    png_sha256: str,
    *,
    root: Path,
    version: str,
) -> dict:
    if sha256_file(source_png) != png_sha256:
        raise ValueError("CGR PNG SHA-256 mismatch")
    load_cgr_tensor(source_png, expected_size=128)
    target_dir = cache_dir(accession, root=root, version=version)
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{version}.tmp-", dir=target_dir.parent))
    try:
        shutil.copyfile(source_png, temp_dir / "cgr.png")
        _write_manifest(temp_dir, accession, fasta_sha256, png_sha256, version)
        _publish(temp_dir, target_dir)
        temp_dir = None
        return validate_reference_cgr(
            accession,
            root=root,
            version=version,
            expected_fasta_sha256=fasta_sha256,
        )
    finally:
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)


@contextmanager
def reference_cache_lock(accession: str, *, root: Path, version: str):
    import fcntl

    directory = cache_dir(accession, root=root, version=version)
    lock_dir = Path(root) / ".locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    with (lock_dir / f"{accession}-{version}.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield directory


@lru_cache(maxsize=128)
def _cached_reference_tensor(
    accession: str, version: str, png_sha256: str, png_path: str, device: str,
) -> torch.Tensor:
    del accession, version, png_sha256
    return load_cgr_tensor(Path(png_path), expected_size=128).to(device)


def get_reference_cgr_tensor(
    accession: str, source: dict | None = None, *, device="cpu",
) -> tuple[torch.Tensor, str]:
    """Return a bounded process-local tensor and its non-sensitive cache status."""
    # The source argument remains accepted for old request.json files, but Docker
    # never downloads references. Only a previously imported cache can be used.
    del source
    entry = validate_reference_cgr(accession)
    before = _cached_reference_tensor.cache_info().hits
    tensor = _cached_reference_tensor(
        accession,
        entry["version"],
        entry["png_sha256"],
        str(entry["png_path"]),
        str(device),
    )
    memory_hit = _cached_reference_tensor.cache_info().hits > before
    return tensor, "memory_hit" if memory_hit else "disk_hit"


def ensure_reference_cgr(accession: str, source: dict | None = None) -> torch.Tensor:
    return get_reference_cgr_tensor(accession, source)[0]


def validate_reference_cgr(
    accession: str,
    *,
    root: Path | None = None,
    version: str | None = None,
    expected_fasta_sha256: str | None = None,
) -> dict:
    try:
        root = SETTINGS.cgr_cache_root if root is None else root
        version = SETTINGS.cgr_version if version is None else version
        directory = cache_dir(accession, root=root, version=version)
        png_path = directory / "cgr.png"
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        fasta_sha256 = manifest.get("fastaSha256")
        png_sha256 = manifest.get("cgrPngSha256")
        if (
            manifest.get("accession") != accession
            or manifest.get("resolution") != 128
            or manifest.get("cgrVersion") != version
            or not isinstance(fasta_sha256, str)
            or not SHA256_RE.fullmatch(fasta_sha256)
            or not isinstance(png_sha256, str)
            or not SHA256_RE.fullmatch(png_sha256)
            or (expected_fasta_sha256 is not None and fasta_sha256 != expected_fasta_sha256)
            or sha256_file(png_path) != png_sha256
        ):
            raise ValueError("invalid cache metadata")
        return {
            "version": version,
            "png_sha256": png_sha256,
            "png_path": png_path,
            "fasta_sha256": fasta_sha256,
        }
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        raise ReferenceCgrNotFound("Reference CGR is unavailable.") from None


def load_reference_cgr(
    accession: str,
    *,
    root: Path | None = None,
    version: str | None = None,
    expected_fasta_sha256: str | None = None,
) -> torch.Tensor:
    entry = validate_reference_cgr(
        accession,
        root=root,
        version=version,
        expected_fasta_sha256=expected_fasta_sha256,
    )
    return load_cgr_tensor(entry["png_path"], expected_size=128)
