#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from urllib.parse import quote


TEST_ORIGIN = 'http://127.0.0.1:3100'


def parse_args():
    parser = argparse.ArgumentParser(description='Verify a complete RAPPTOR release on a Hugging Face Dataset.')
    parser.add_argument('--repo', default=os.environ.get('HF_REPO_ID'), help='Dataset repository as owner/name (or set HF_REPO_ID).')
    parser.add_argument('--release', default='2026-08-07')
    parser.add_argument('--revision', default='main')
    parser.add_argument('--endpoint', default=os.environ.get('HF_ENDPOINT', 'https://huggingface.co'))
    parser.add_argument('--range-samples', type=int, default=4, help='Deterministic samples per compressed asset type.')
    parser.add_argument('--threads', type=int, default=8)
    args = parser.parse_args()
    if not args.repo or '/' not in args.repo:
        parser.error('provide --repo owner/name or set HF_REPO_ID')
    if not args.endpoint.startswith('https://'):
        parser.error('--endpoint must use HTTPS')
    if args.range_samples < 0 or args.threads <= 0:
        parser.error('--range-samples cannot be negative and --threads must be positive')
    return args


def read_checksums(release_root):
    checksums = {}
    for line in (release_root / 'checksums.sha256').read_text(encoding='utf-8').splitlines():
        digest, relative = line.split('  ', 1)
        checksums[relative] = digest
    checksums['checksums.sha256'] = hashlib.sha256((release_root / 'checksums.sha256').read_bytes()).hexdigest()
    return checksums


def git_blob_sha1(path):
    size = path.stat().st_size
    digest = hashlib.sha1()
    digest.update(f'blob {size}\0'.encode())
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def evenly_spaced(values, count):
    if not values or count <= 0:
        return []
    if len(values) <= count:
        return values
    if count == 1:
        return [values[0]]
    return [values[round(index * (len(values) - 1) / (count - 1))] for index in range(count)]


def verify_range(url):
    import requests

    headers = {'Range': 'bytes=0-127', 'Origin': TEST_ORIGIN, 'Accept-Encoding': 'identity'}
    last_error = None
    for attempt in range(4):
        try:
            response = requests.get(url, headers=headers, timeout=60)
            if response.status_code != 206:
                raise RuntimeError(f'{url} returned {response.status_code}; expected 206')
            if not response.headers.get('Content-Range', '').startswith('bytes 0-127/'):
                raise RuntimeError(f'{url} returned an invalid Content-Range')
            cors = response.headers.get('Access-Control-Allow-Origin')
            if cors not in ('*', TEST_ORIGIN):
                raise RuntimeError(f'{url} does not allow browser CORS for {TEST_ORIGIN}')
            if len(response.content) != 128:
                raise RuntimeError(f'{url} returned {len(response.content)} bytes; expected 128')
            return
        except Exception as error:
            last_error = error
            if attempt < 3:
                time.sleep(2 ** attempt)
    raise last_error


def main():
    args = parse_args()
    try:
        from huggingface_hub import HfApi
    except ImportError as error:
        raise SystemExit('Install the official client first: python -m pip install --upgrade huggingface_hub') from error

    project_root = Path(__file__).resolve().parent.parent
    release_root = project_root / '.data' / 'releases' / args.release
    if not release_root.is_dir():
        raise SystemExit(f'Release source is missing: {release_root}')
    checksums = read_checksums(release_root)
    prefix = f'releases/{args.release}'
    api = HfApi(endpoint=args.endpoint, token=os.environ.get('HF_TOKEN'))
    remote_items = {
        item.path.removeprefix(f'{prefix}/'): item
        for item in api.list_repo_tree(
            repo_id=args.repo,
            path_in_repo=prefix,
            recursive=True,
            expand=True,
            revision=args.revision,
            repo_type='dataset',
        )
        if hasattr(item, 'size') and item.path.startswith(f'{prefix}/')
    }

    failures = []
    lfs_verified = 0
    git_verified = 0
    total_bytes = 0
    for relative, expected_sha256 in checksums.items():
        local_path = release_root / Path(PurePosixPath(relative))
        item = remote_items.get(relative)
        if item is None:
            failures.append(f'missing: {relative}')
            continue
        local_size = local_path.stat().st_size
        total_bytes += local_size
        if item.size != local_size:
            failures.append(f'size mismatch: {relative} (local {local_size}, remote {item.size})')
            continue
        if item.lfs is not None:
            if item.lfs.sha256 != expected_sha256:
                failures.append(f'SHA-256 mismatch: {relative}')
            else:
                lfs_verified += 1
        elif item.blob_id != git_blob_sha1(local_path):
            failures.append(f'Git blob mismatch: {relative}')
        else:
            git_verified += 1

    extras = sorted(set(remote_items) - set(checksums))
    if extras:
        failures.extend(f'unexpected remote file: {relative}' for relative in extras)
    if failures:
        preview = '\n'.join(failures[:30])
        suffix = f'\n... and {len(failures) - 30} more' if len(failures) > 30 else ''
        raise SystemExit(f'Remote release verification failed ({len(failures)} problems):\n{preview}{suffix}')

    categories = {
        'reference': sorted(path for path in checksums if path.endswith('/reference.fa.gz')),
        'promoters': sorted(path for path in checksums if path.endswith('/predicted-promoters.gff3.gz')),
        'annotations': sorted(path for path in checksums if path.endswith('/ncbi-annotations.gff3.gz')),
    }
    samples = [path for values in categories.values() for path in evenly_spaced(values, args.range_samples)]
    base = f"{args.endpoint.rstrip('/')}/datasets/{args.repo}/resolve/{quote(args.revision, safe='')}/{prefix}"
    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        list(pool.map(verify_range, [f"{base}/{quote(path, safe='/')}" for path in samples]))

    result = {
        'repo': args.repo,
        'release': args.release,
        'files': len(checksums),
        'bytes': total_bytes,
        'lfsSha256Verified': lfs_verified,
        'gitBlobVerified': git_verified,
        'rangeCorsSamples': len(samples),
        'storageBaseUrl': f'{base}/objects',
        'releaseAssetBaseUrl': base,
    }
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
