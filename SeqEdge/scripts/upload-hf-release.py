#!/usr/bin/env python3

import argparse
import hashlib
import os
import time
from pathlib import Path, PurePosixPath


RELEASE_FILES = ('catalog.json', 'manifest.tsv', 'release.json', 'checksums.sha256')
OBSOLETE_PILOT_FILES = ('SEQEDGE-HF-PILOT.md', 'pilot-manifest.tsv')


def parse_args():
    parser = argparse.ArgumentParser(description='Upload a complete SeqEdge release to a Hugging Face Dataset.')
    parser.add_argument('--repo', default=os.environ.get('HF_REPO_ID'), help='Dataset repository as owner/name (or set HF_REPO_ID).')
    parser.add_argument('--release', default='2026-08-07')
    parser.add_argument('--revision', default='main')
    parser.add_argument('--batch-size', type=int, default=50, help='Accessions per resumable commit.')
    parser.add_argument('--threads', type=int, default=8, help='Concurrent files uploaded by huggingface_hub.')
    parser.add_argument('--retries', type=int, default=3)
    parser.add_argument('--private', action='store_true', help='Create a private Dataset if it does not exist.')
    parser.add_argument('--dry-run', action='store_true', help='Validate and summarize local files without contacting Hugging Face.')
    args = parser.parse_args()
    if not args.repo or '/' not in args.repo:
        parser.error('provide --repo owner/name or set HF_REPO_ID')
    if not args.batch_size > 0 or not args.threads > 0 or args.retries < 0:
        parser.error('--batch-size and --threads must be positive; --retries cannot be negative')
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


def load_local_release(project_root, release):
    release_root = project_root / '.data' / 'releases' / release
    if not release_root.is_dir():
        raise SystemExit(f'Release source is missing: {release_root}')
    checksums = read_checksums(release_root)
    expected = set(checksums)
    required = set(RELEASE_FILES)
    if not required.issubset(expected):
        missing = ', '.join(sorted(required - expected))
        raise SystemExit(f'Release checksum inventory is incomplete: {missing}')
    for relative in sorted(expected):
        path = release_root / Path(PurePosixPath(relative))
        if not path.is_file():
            raise SystemExit(f'Release file is missing: {relative}')
    object_paths = sorted(relative for relative in expected if relative.startswith('objects/'))
    accessions = sorted({relative.split('/', 2)[1] for relative in object_paths})
    return release_root, checksums, object_paths, accessions


def remote_matches(item, local_path, expected_sha256):
    if item is None or item.size != local_path.stat().st_size:
        return False
    if item.lfs is not None:
        return item.lfs.sha256 == expected_sha256
    return item.blob_id == git_blob_sha1(local_path)


def create_commit_with_retry(api, args, operations, message):
    for attempt in range(args.retries + 1):
        try:
            return api.create_commit(
                repo_id=args.repo,
                repo_type='dataset',
                revision=args.revision,
                operations=operations,
                commit_message=message,
                num_threads=args.threads,
            )
        except Exception:
            if attempt >= args.retries:
                raise
            delay = 2 ** (attempt + 1)
            print(f'Commit failed; retrying in {delay}s ({attempt + 1}/{args.retries})', flush=True)
            time.sleep(delay)


def main():
    args = parse_args()
    project_root = Path(__file__).resolve().parent.parent
    release_root, checksums, object_paths, accessions = load_local_release(project_root, args.release)
    total_bytes = sum((release_root / Path(PurePosixPath(relative))).stat().st_size for relative in checksums)
    batches = (len(accessions) + args.batch_size - 1) // args.batch_size
    print(f'Local release: {len(accessions)} accessions, {len(checksums)} files, {total_bytes} bytes, up to {batches} commits', flush=True)
    if args.dry_run:
        return

    try:
        from huggingface_hub import CommitOperationAdd, HfApi
    except ImportError as error:
        raise SystemExit('Install the official client first: python -m pip install --upgrade huggingface_hub') from error

    api = HfApi(token=os.environ.get('HF_TOKEN'))
    api.create_repo(repo_id=args.repo, repo_type='dataset', private=args.private, exist_ok=True)
    prefix = f'releases/{args.release}'
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

    pending = []
    verified_remote = 0
    for relative, expected_sha256 in checksums.items():
        local_path = release_root / Path(PurePosixPath(relative))
        if remote_matches(remote_items.get(relative), local_path, expected_sha256):
            verified_remote += 1
        else:
            pending.append(relative)
    print(f'Remote preflight: {verified_remote} exact files, {len(pending)} files pending', flush=True)

    pending_set = set(pending)
    root_pending = [relative for relative in RELEASE_FILES if relative in pending_set]
    if root_pending:
        operations = [CommitOperationAdd(path_in_repo=f'{prefix}/{relative}', path_or_fileobj=release_root / relative) for relative in root_pending]
        create_commit_with_retry(api, args, operations, f'Add SeqEdge {args.release} release metadata')
        print(f'Uploaded release metadata ({len(root_pending)} files)', flush=True)

    paths_by_accession = {accession: [] for accession in accessions}
    for relative in object_paths:
        if relative in pending_set:
            paths_by_accession[relative.split('/', 2)[1]].append(relative)

    pending_accessions = [accession for accession in accessions if paths_by_accession[accession]]
    upload_batches = [pending_accessions[index:index + args.batch_size] for index in range(0, len(pending_accessions), args.batch_size)]
    for index, batch in enumerate(upload_batches, start=1):
        paths = [relative for accession in batch for relative in paths_by_accession[accession]]
        operations = [
            CommitOperationAdd(path_in_repo=f'{prefix}/{relative}', path_or_fileobj=release_root / Path(PurePosixPath(relative)))
            for relative in paths
        ]
        create_commit_with_retry(api, args, operations, f'Add SeqEdge {args.release} genomes {batch[0]} through {batch[-1]}')
        uploaded_bytes = sum((release_root / Path(PurePosixPath(relative))).stat().st_size for relative in paths)
        print(f'Uploaded batch {index}/{len(upload_batches)}: {len(batch)} accessions, {len(paths)} files, {uploaded_bytes} bytes', flush=True)

    obsolete = [f'{prefix}/{name}' for name in OBSOLETE_PILOT_FILES if name in remote_items]
    if obsolete:
        api.delete_files(
            repo_id=args.repo,
            repo_type='dataset',
            revision=args.revision,
            delete_patterns=obsolete,
            commit_message=f'Remove superseded SeqEdge {args.release} pilot markers',
        )
        print(f'Removed {len(obsolete)} superseded pilot marker files (recoverable in Dataset history)', flush=True)

    print(f'Upload complete: https://huggingface.co/datasets/{args.repo}/tree/{args.revision}/{prefix}', flush=True)


if __name__ == '__main__':
    main()
