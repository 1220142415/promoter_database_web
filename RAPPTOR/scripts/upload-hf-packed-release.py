#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import re
import time
from pathlib import Path
from pathlib import PurePosixPath


MAX_COMMIT_BYTES = 2 * 1024 * 1024 * 1024
MAX_PACKS = 20
MAX_METADATA_FILES = 100
HEX_SHA256 = set('0123456789abcdef')
HEX_SHA1 = set('0123456789abcdef')


def parse_args():
    parser = argparse.ArgumentParser(description='Resume a packed RAPPTOR release upload using the shared JSON plan.')
    parser.add_argument('--release', default='2026-08-11')
    parser.add_argument('--retries', type=int, default=3)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--max-batches', type=int)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.retries < 0 or args.threads <= 0 or (args.max_batches is not None and args.max_batches < 0):
        parser.error('invalid retry/thread/batch limit')
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


def save_plan(path, plan):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def object_value(value, name, default=None):
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def valid_hex(value, length, alphabet):
    return isinstance(value, str) and len(value) == length and all(char in alphabet for char in value)


def validate_plan(plan):
    if plan.get('schemaVersion') != 1:
        raise ValueError('Unsupported upload plan schemaVersion')
    release = plan.get('release')
    repo = plan.get('repo')
    revision = plan.get('revision')
    if not isinstance(release, str) or not release or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for char in release):
        raise ValueError('Invalid release id in upload plan')
    if not isinstance(repo, str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*', repo) is None:
        raise ValueError('Invalid dataset repo in upload plan')
    if not isinstance(revision, str) or not revision:
        raise ValueError('Invalid revision in upload plan')
    if not isinstance(plan.get('batches'), list):
        raise ValueError('Upload plan batches must be an array')

    batch_ids = set()
    remote_paths = set()
    release_prefix = f'releases/{release}/'
    for batch in plan['batches']:
        batch_id = batch.get('id')
        if not isinstance(batch_id, str) or not batch_id or batch_id in batch_ids:
            raise ValueError(f'Invalid or duplicate batch id: {batch_id!r}')
        batch_ids.add(batch_id)
        if batch.get('status') not in {'pending', 'uploading', 'failed', 'complete'}:
            raise ValueError(f'{batch_id}: invalid status')
        files = batch.get('files')
        if not isinstance(files, list) or not files:
            raise ValueError(f'{batch_id}: files must be a non-empty array')
        directory = batch.get('remoteDirectory')
        release_root = release_prefix.rstrip('/')
        if not isinstance(directory, str) or (directory != release_root and not directory.startswith(release_prefix)):
            raise ValueError(f'{batch_id}: invalid remote directory')
        kinds = {file.get('kind') for file in files if isinstance(file, dict)}
        if len(kinds) != 1 or not kinds.issubset({'pack', 'metadata'}):
            raise ValueError(f'{batch_id}: mixed or invalid file kinds')
        maximum_files = MAX_PACKS if kinds == {'pack'} else MAX_METADATA_FILES
        if len(files) > maximum_files:
            raise ValueError(f'{batch_id}: file count exceeds batch limit')
        calculated_bytes = 0
        for file in files:
            if not isinstance(file, dict):
                raise ValueError(f'{batch_id}: invalid file entry')
            remote_path = file.get('remotePath')
            if not isinstance(remote_path, str) or not remote_path.startswith(release_prefix):
                raise ValueError(f'{batch_id}: remote path is outside the release')
            pure_path = PurePosixPath(remote_path)
            if '\\' in remote_path or str(pure_path) != remote_path or '..' in pure_path.parts or str(pure_path.parent) != directory:
                raise ValueError(f'{batch_id}: unsafe or misplaced remote path: {remote_path}')
            if remote_path in remote_paths:
                raise ValueError(f'Duplicate remote path: {remote_path}')
            remote_paths.add(remote_path)
            size = file.get('bytes')
            if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                raise ValueError(f'{remote_path}: invalid byte size')
            if size > MAX_COMMIT_BYTES:
                raise ValueError(f'{remote_path}: a single file exceeds the 2 GiB commit limit')
            if not valid_hex(file.get('sha256'), 64, HEX_SHA256):
                raise ValueError(f'{remote_path}: invalid SHA-256')
            if file['kind'] == 'metadata' and not valid_hex(file.get('gitBlobSha1'), 40, HEX_SHA1):
                raise ValueError(f'{remote_path}: invalid Git blob SHA-1')
            if file['kind'] == 'pack' and file.get('gitBlobSha1') is not None and not valid_hex(file.get('gitBlobSha1'), 40, HEX_SHA1):
                raise ValueError(f'{remote_path}: invalid optional Git blob SHA-1')
            if not isinstance(file.get('localPath'), str) or not file['localPath']:
                raise ValueError(f'{remote_path}: invalid local path')
            if file['kind'] == 'pack':
                parts = pure_path.parts
                filename = parts[-1]
                if len(parts) != 4 or parts[2] != 'packs' or re.fullmatch(r'pack-[0-9a-f]{2}-[0-9]{3}\.bin', filename) is None:
                    raise ValueError(f'{remote_path}: invalid Pack path')
            elif '/packs/' in remote_path:
                raise ValueError(f'{remote_path}: metadata cannot use the Pack directory')
            calculated_bytes += size
        if calculated_bytes != batch.get('bytes') or calculated_bytes > MAX_COMMIT_BYTES:
            raise ValueError(f'{batch_id}: invalid or oversized batch byte total')


def remote_matches(item, file):
    if item is None or object_value(item, 'size') != file['bytes']:
        return False
    lfs = object_value(item, 'lfs')
    if lfs is not None:
        digest = object_value(lfs, 'sha256') or object_value(lfs, 'oid')
        if isinstance(digest, str) and digest.startswith('sha256:'):
            digest = digest.removeprefix('sha256:')
        return digest == file['sha256']
    return object_value(item, 'blob_id') == file['gitBlobSha1']


def verify_remote_batch(api, plan, batch):
    remote = {
        item.path: item
        for item in api.list_repo_tree(
            repo_id=plan['repo'], repo_type='dataset', revision=plan['revision'],
            path_in_repo=batch['remoteDirectory'], recursive=False, expand=True,
        )
        if object_value(item, 'size') is not None
    }
    for file in batch['files']:
        item = remote.get(file['remotePath'])
        if not remote_matches(item, file):
            raise RuntimeError(f"Remote verification failed: {file['remotePath']}")


def recheck_completed_batches(api, plan):
    pending = []
    for batch in plan['batches']:
        if batch['status'] == 'complete':
            try:
                verify_remote_batch(api, plan, batch)
                batch['verifiedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                batch.pop('error', None)
                continue
            except Exception as error:
                batch['status'] = 'pending'
                batch['error'] = 'Remote recheck failed: ' + str(error)
                batch.pop('verifiedAt', None)
                batch.pop('completedAt', None)
        pending.append(batch)
    return pending


def main():
    args = parse_args()
    project_root = Path(__file__).resolve().parent.parent
    plan_path = project_root / '.data' / 'upload-plans' / f'{args.release}.json'
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    validate_plan(plan)
    if plan['release'] != args.release:
        raise SystemExit(f"Plan release is {plan['release']}, not {args.release}")
    try:
        from huggingface_hub import CommitOperationAdd, HfApi
    except ImportError as error:
        raise SystemExit('Install huggingface_hub before using the CLI fallback.') from error

    api = HfApi(token=os.environ.get('HF_TOKEN'))
    pending = recheck_completed_batches(api, plan)
    save_plan(plan_path, plan)
    if args.max_batches is not None:
        pending = pending[:args.max_batches]
    print(f"Shared plan: {len(plan['batches'])} batches, {len(pending)} selected, repo={plan['repo']}", flush=True)
    for batch in pending:
        for file in batch['files']:
            local = Path(file['localPath'])
            if not local.is_file() or local.stat().st_size != file['bytes']:
                raise SystemExit(f"Local file missing or size changed: {file['remotePath']}")
            if sha256_file(local) != file['sha256']:
                raise SystemExit(f"Local SHA-256 changed: {file['remotePath']}")
            if file.get('gitBlobSha1') and git_blob_sha1(local) != file['gitBlobSha1']:
                raise SystemExit(f"Local Git blob SHA-1 changed: {file['remotePath']}")
    if args.dry_run:
        return

    for batch in pending:
        batch['attempts'] += 1
        batch['status'] = 'uploading'
        save_plan(plan_path, plan)
        try:
            remote = {
                item.path: item
                for item in api.list_repo_tree(
                    repo_id=plan['repo'], repo_type='dataset', revision=plan['revision'],
                    path_in_repo=batch['remoteDirectory'], recursive=False, expand=True,
                )
                if object_value(item, 'size') is not None
            }
            conflicts = [file['remotePath'] for file in batch['files'] if remote.get(file['remotePath']) is not None and not remote_matches(remote.get(file['remotePath']), file)]
            if conflicts:
                raise RuntimeError('Immutable release conflict: ' + ', '.join(conflicts[:5]) + (f' and {len(conflicts) - 5} more' if len(conflicts) > 5 else ''))
            upload_files = [file for file in batch['files'] if remote.get(file['remotePath']) is None]
            if upload_files:
                operations = [CommitOperationAdd(path_in_repo=file['remotePath'], path_or_fileobj=file['localPath']) for file in upload_files]
                result = None
                for attempt in range(args.retries + 1):
                    try:
                        result = api.create_commit(
                            repo_id=plan['repo'], repo_type='dataset', revision=plan['revision'],
                            operations=operations, commit_message=f"Upload RAPPTOR {plan['release']} {batch['id']}",
                            num_threads=args.threads,
                        )
                        break
                    except Exception:
                        if attempt >= args.retries:
                            raise
                        time.sleep(2 ** (attempt + 1))
                if result is None or not object_value(result, 'commit_url'):
                    raise RuntimeError('Hugging Face did not return a commit URL')
                batch['commitUrl'] = object_value(result, 'commit_url')
            else:
                batch['commitUrl'] = batch.get('commitUrl') or f"https://huggingface.co/datasets/{plan['repo']}/tree/{plan['revision']}/{batch['remoteDirectory']}"
            verify_remote_batch(api, plan, batch)
            batch['status'] = 'complete'
            batch['verifiedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            batch['completedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            batch.pop('error', None)
            save_plan(plan_path, plan)
            print(f"Completed {batch['id']}: {batch['commitUrl']}", flush=True)
        except Exception as error:
            batch['status'] = 'failed'
            batch['error'] = str(error)
            save_plan(plan_path, plan)
            raise


if __name__ == '__main__':
    main()
