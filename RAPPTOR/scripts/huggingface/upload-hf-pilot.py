#!/usr/bin/env python3

import argparse
import os
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description='Create and upload the RAPPTOR Hugging Face Dataset pilot.')
    parser.add_argument('--repo', default=os.environ.get('HF_REPO_ID'), help='Dataset repository as owner/name (or set HF_REPO_ID).')
    parser.add_argument('--release', default='2026-08-07')
    parser.add_argument('--private', action='store_true', help='Create a private pilot instead of the default public Dataset.')
    return parser.parse_args()


def main():
    args = parse_args()
    if not args.repo or '/' not in args.repo:
        raise SystemExit('Provide --repo owner/name or set HF_REPO_ID.')

    try:
        from huggingface_hub import HfApi
    except ImportError as error:
        raise SystemExit('Install the official client first: python -m pip install --upgrade huggingface_hub') from error

    project_root = Path(__file__).resolve().parent.parent
    source = project_root / '.data' / 'hf-pilot' / 'releases' / args.release
    if not source.is_dir():
        raise SystemExit(f'Pilot files are missing: {source}. Run npm run hf:prepare first.')

    api = HfApi(token=os.environ.get('HF_TOKEN'))
    api.create_repo(repo_id=args.repo, repo_type='dataset', private=args.private, exist_ok=True)
    api.upload_folder(
        folder_path=str(source),
        path_in_repo=f'releases/{args.release}',
        repo_id=args.repo,
        repo_type='dataset',
        commit_message=f'Add RAPPTOR {args.release} two-genome storage pilot',
    )
    print(f'Uploaded https://huggingface.co/datasets/{args.repo}/tree/main/releases/{args.release}')


if __name__ == '__main__':
    main()
