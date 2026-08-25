#!/usr/bin/env python3

"""Verify a packed RAPPTOR release against Hugging Face repository metadata.

The default mode reads the repository tree through huggingface_hub.  ``--dry-run``
performs only local/plan validation, while ``--offline-tree`` verifies a saved,
sanitised repository-tree snapshot without making any network request.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path


_UPLOAD_MODULE_PATH = Path(__file__).with_name('upload-hf-packed-release.py')
_UPLOAD_SPEC = importlib.util.spec_from_file_location('rapptor_upload_hf_packed_release', _UPLOAD_MODULE_PATH)
if _UPLOAD_SPEC is None or _UPLOAD_SPEC.loader is None:
    raise RuntimeError(f'Cannot load shared upload helpers from {_UPLOAD_MODULE_PATH}')
_UPLOAD_MODULE = importlib.util.module_from_spec(_UPLOAD_SPEC)
_UPLOAD_SPEC.loader.exec_module(_UPLOAD_MODULE)
object_value = _UPLOAD_MODULE.object_value
remote_matches = _UPLOAD_MODULE.remote_matches
validate_plan = _UPLOAD_MODULE.validate_plan


def parse_args():
    parser = argparse.ArgumentParser(description='Verify all physical objects in a packed RAPPTOR Hugging Face release.')
    parser.add_argument('--release', default='2026-08-11')
    parser.add_argument('--repo', help='Override/check the Dataset repo recorded in the shared upload plan.')
    parser.add_argument('--revision', help='Override/check the revision recorded in the shared upload plan.')
    parser.add_argument('--plan', type=Path, help='Shared upload plan path (defaults to .data/upload-plans/<release>.json).')
    parser.add_argument('--endpoint', default=os.environ.get('HF_ENDPOINT', 'https://huggingface.co'))
    parser.add_argument('--offline-tree', type=Path, help='Verify against a sanitised JSON tree snapshot instead of Hugging Face.')
    parser.add_argument('--write-snapshot', type=Path, help='Write the fetched sanitised tree for a later offline verification.')
    parser.add_argument('--dry-run', action='store_true', help='Validate the plan and local files without contacting Hugging Face.')
    parser.add_argument('--verify-local-hashes', action='store_true', help='Re-hash every local object in addition to checking its size.')
    args = parser.parse_args()
    if not args.endpoint.startswith('https://'):
        parser.error('--endpoint must use HTTPS')
    if args.dry_run and (args.offline_tree or args.write_snapshot):
        parser.error('--dry-run cannot be combined with --offline-tree or --write-snapshot')
    if args.offline_tree and args.write_snapshot:
        parser.error('--offline-tree cannot be combined with --write-snapshot')
    return args


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def git_blob_sha1(path):
    digest = hashlib.sha1()
    digest.update(f'blob {path.stat().st_size}\0'.encode())
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def expected_files(plan):
    return {
        file['remotePath']: file
        for batch in plan['batches']
        for file in batch['files']
    }


def verify_pack_manifest(project_root, plan, files):
    root = project_root / '.data' / 'releases' / plan['release']
    manifest_path = root / 'packs-manifest.tsv'
    lines = manifest_path.read_text(encoding='utf-8').splitlines()
    if not lines or lines[0] != 'path\tbytes\tsha256':
        raise ValueError('Invalid local packs-manifest.tsv header')
    manifest_packs = {}
    for line in lines[1:]:
        if not line:
            continue
        fields = line.split('\t')
        if len(fields) != 3:
            raise ValueError(f'Invalid local Pack manifest row: {line}')
        remote_path, size_text, sha256 = fields
        if remote_path in manifest_packs:
            raise ValueError(f'Duplicate path in local Pack manifest: {remote_path}')
        manifest_packs[remote_path] = (int(size_text), sha256)
    planned_packs = {path: file for path, file in files.items() if file['kind'] == 'pack'}
    if set(manifest_packs) != set(planned_packs):
        raise ValueError('Upload plan Pack paths differ from packs-manifest.tsv')
    for remote_path, (size, sha256) in manifest_packs.items():
        file = planned_packs[remote_path]
        if file['bytes'] != size or file['sha256'] != sha256:
            raise ValueError(f'{remote_path}: upload plan differs from packs-manifest.tsv')


def verify_local_files(files, verify_hashes):
    failures = []
    for remote_path, file in files.items():
        local = Path(file['localPath'])
        if not local.is_file():
            if file['kind'] == 'metadata' or verify_hashes:
                failures.append(f'missing local file: {remote_path}')
            continue
        if local.stat().st_size != file['bytes']:
            failures.append(f'local size mismatch: {remote_path}')
            continue
        if verify_hashes:
            if sha256_file(local) != file['sha256']:
                failures.append(f'local SHA-256 mismatch: {remote_path}')
            if file.get('gitBlobSha1') and git_blob_sha1(local) != file['gitBlobSha1']:
                failures.append(f'local Git blob SHA-1 mismatch: {remote_path}')
    if failures:
        raise ValueError(format_failures('Local packed release verification failed', failures))


def normalise_remote_item(item):
    path = object_value(item, 'path')
    size = object_value(item, 'size')
    lfs = object_value(item, 'lfs')
    sha256 = object_value(lfs, 'sha256') or object_value(lfs, 'oid') if lfs is not None else None
    if isinstance(sha256, str) and sha256.startswith('sha256:'):
        sha256 = sha256.removeprefix('sha256:')
    return {
        'path': path,
        'size': size,
        'lfs': {'sha256': sha256} if sha256 else None,
        'blob_id': object_value(item, 'blob_id') or object_value(item, 'blobId'),
    }


def read_offline_tree(path):
    value = json.loads(path.read_text(encoding='utf-8'))
    items = value.get('items') if isinstance(value, dict) else value
    if not isinstance(items, list):
        raise ValueError('Offline tree must be a JSON array or an object with an items array')
    return [normalise_remote_item(item) for item in items]


def fetch_remote_tree(plan, endpoint):
    try:
        from huggingface_hub import HfApi
    except ImportError as error:
        raise SystemExit('Install huggingface_hub before live verification.') from error
    api = HfApi(endpoint=endpoint, token=os.environ.get('HF_TOKEN'))
    prefix = f"releases/{plan['release']}"
    return [
        normalise_remote_item(item)
        for item in api.list_repo_tree(
            repo_id=plan['repo'], repo_type='dataset', revision=plan['revision'],
            path_in_repo=prefix, recursive=True, expand=True,
        )
        if object_value(item, 'size') is not None
    ]


def format_failures(title, failures):
    preview = '\n'.join(failures[:40])
    suffix = f'\n... and {len(failures) - 40} more' if len(failures) > 40 else ''
    return f'{title} ({len(failures)} problems):\n{preview}{suffix}'


def verify_remote_tree(plan, files, items):
    remote = {}
    failures = []
    prefix = f"releases/{plan['release']}/"
    for item in items:
        path = item.get('path')
        if not isinstance(path, str) or not path.startswith(prefix):
            continue
        if path in remote:
            failures.append(f'duplicate remote path: {path}')
        remote[path] = item
    for remote_path, file in files.items():
        item = remote.get(remote_path)
        if item is None:
            failures.append(f'missing remote file: {remote_path}')
        elif not remote_matches(item, file):
            if item.get('size') != file['bytes']:
                failures.append(f'remote size mismatch: {remote_path} (expected {file["bytes"]}, got {item.get("size")})')
            elif item.get('lfs') is not None:
                failures.append(f'remote LFS SHA-256 mismatch: {remote_path}')
            else:
                failures.append(f'remote Git blob mismatch: {remote_path}')
    failures.extend(f'unexpected remote file: {path}' for path in sorted(set(remote) - set(files)))
    if failures:
        raise ValueError(format_failures('Remote packed release verification failed', failures))
    return {
        'lfsSha256Verified': sum(1 for item in remote.values() if item.get('lfs') is not None),
        'gitBlobVerified': sum(1 for item in remote.values() if item.get('lfs') is None),
    }


def main():
    args = parse_args()
    project_root = Path(__file__).resolve().parent.parent
    plan_path = args.plan or project_root / '.data' / 'upload-plans' / f'{args.release}.json'
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    validate_plan(plan)
    if plan['release'] != args.release:
        raise SystemExit(f"Plan release is {plan['release']}, not {args.release}")
    if args.repo and args.repo != plan['repo']:
        raise SystemExit(f"Plan repo is {plan['repo']}, not {args.repo}")
    if args.revision and args.revision != plan['revision']:
        raise SystemExit(f"Plan revision is {plan['revision']}, not {args.revision}")

    files = expected_files(plan)
    verify_pack_manifest(project_root, plan, files)
    verify_local_files(files, args.verify_local_hashes)
    counts = {
        'packs': sum(1 for file in files.values() if file['kind'] == 'pack'),
        'metadata': sum(1 for file in files.values() if file['kind'] == 'metadata'),
        'bytes': sum(file['bytes'] for file in files.values()),
    }
    if args.dry_run:
        print(json.dumps({'mode': 'dry-run', 'repo': plan['repo'], 'release': plan['release'], **counts}, indent=2))
        return

    items = read_offline_tree(args.offline_tree) if args.offline_tree else fetch_remote_tree(plan, args.endpoint)
    if args.write_snapshot:
        args.write_snapshot.parent.mkdir(parents=True, exist_ok=True)
        args.write_snapshot.write_text(json.dumps({'schemaVersion': 1, 'items': items}, indent=2) + '\n', encoding='utf-8')
    verified = verify_remote_tree(plan, files, items)
    print(json.dumps({
        'mode': 'offline' if args.offline_tree else 'live',
        'repo': plan['repo'], 'release': plan['release'], 'revision': plan['revision'],
        'files': len(files), **counts, **verified,
    }, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(str(error)) from error
