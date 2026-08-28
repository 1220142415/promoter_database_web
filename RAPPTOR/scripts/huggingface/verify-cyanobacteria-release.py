#!/usr/bin/env python3
"""Verify the complete cyanobacteria browser release on Hugging Face."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path
from urllib.parse import quote

import httpx
from huggingface_hub import HfApi


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def remote_url(repo: str, revision: str, path: str) -> str:
    encoded_repo = "/".join(quote(part, safe="") for part in repo.split("/"))
    return f"https://huggingface.co/datasets/{encoded_repo}/resolve/{quote(revision, safe='')}/{quote(path, safe='/')}"


def hash_remote(client: httpx.Client, url: str, attempts: int = 3) -> tuple[int, str, str | None]:
    last_error: Exception | None = None
    for attempt in range(attempts):
        digest = hashlib.sha256()
        size = 0
        try:
            with client.stream("GET", url, headers={"Accept-Encoding": "identity"}) as response:
                response.raise_for_status()
                cors = response.headers.get("access-control-allow-origin")
                for chunk in response.iter_raw():
                    digest.update(chunk)
                    size += len(chunk)
            return size, digest.hexdigest(), cors
        except (httpx.HTTPError, OSError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Remote download failed after {attempts} attempts: {url}") from last_error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="liurulong/bacterial-promoter-genomes")
    parser.add_argument("--revision", default="main")
    parser.add_argument("--release", default="2026-08-27")
    parser.add_argument("--local-root", type=Path)
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[2]
    local_root = (args.local_root or project_root / ".data" / "cyanobacteria" / "releases" / args.release).resolve()
    prefix = f"cyanobacteria/releases/{args.release}"
    local_files = sorted(path for path in local_root.rglob("*") if path.is_file())
    if not local_files:
        raise SystemExit(f"Local release is missing: {local_root}")
    expected = {
        f"{prefix}/{path.relative_to(local_root).as_posix()}": (path.stat().st_size, sha256_file(path))
        for path in local_files
    }

    api = HfApi()
    remote_entries = list(api.list_repo_tree(
        args.repo,
        path_in_repo=prefix,
        repo_type="dataset",
        revision=args.revision,
        recursive=True,
        expand=True,
    ))
    observed = {entry.path: entry.size for entry in remote_entries if hasattr(entry, "size")}
    if set(observed) != set(expected):
        missing = sorted(set(expected) - set(observed))
        extra = sorted(set(observed) - set(expected))
        raise SystemExit(f"Remote tree differs from local release: missing={missing}, extra={extra}")
    for path, (size, _digest) in expected.items():
        if observed[path] != size:
            raise SystemExit(f"Remote size mismatch for {path}: {observed[path]} != {size}")

    cors_values: set[str] = set()
    transferred = 0
    with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(120, connect=30)) as client:
        for index, (path, (expected_size, expected_digest)) in enumerate(expected.items(), 1):
            size, digest, cors = hash_remote(client, remote_url(args.repo, args.revision, path))
            if size != expected_size or digest != expected_digest:
                raise SystemExit(f"Remote SHA-256 verification failed for {path}")
            transferred += size
            if cors:
                cors_values.add(cors)
            print(f"Verified {index}/{len(expected)} {path}", flush=True)

        range_path = f"{prefix}/Cf6912/candidate-peak-scores.plus.bw"
        response = client.get(
            remote_url(args.repo, args.revision, range_path),
            headers={"Range": "bytes=0-99", "Accept-Encoding": "identity", "Origin": "https://example.org"},
        )
        expected_range = f"bytes 0-99/{expected[range_path][0]}"
        if response.status_code != 206 or len(response.content) != 100 or response.headers.get("content-range") != expected_range:
            raise SystemExit("Remote BigWig Range response is invalid")
        range_cors = response.headers.get("access-control-allow-origin")
        if range_cors not in {"*", "https://example.org"}:
            raise SystemExit(f"Remote BigWig CORS header is invalid: {range_cors!r}")

    print(json.dumps({
        "repo": args.repo,
        "revision": args.revision,
        "prefix": prefix,
        "files": len(expected),
        "bytes": transferred,
        "sha256Verified": True,
        "rangeVerified": True,
        "cors": sorted(cors_values | {range_cors}),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
