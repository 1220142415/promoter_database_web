# 早期 Hugging Face 逐文件上传流程

> 历史参考。当前发布入口为 [数据发布手册](../data-release.md)。

## Object storage

Upload the contents of `.data/releases/2026-08-07/objects/` to an object-storage prefix and set:

```env
NEXT_PUBLIC_STORAGE_BASE_URL=https://storage.example.org/rapptor/2026-08-07
NEXT_PUBLIC_RELEASE_ASSET_BASE_URL=https://storage.example.org/rapptor/2026-08-07
```

The storage origin must allow GET, HEAD, Range requests, and the deployed portal origin through CORS. Upload the release-level JSON, TSV, and checksum files to the release root.

### Hugging Face two-genome pilot

The phase-two pilot uses `GCA_000411415.1` (NCBI annotation available) and `GCA_000421325.1` (annotation unavailable). Prepare the upload directory without modifying the release:

```bash
npm run hf:prepare
```

Install the official Hub client, authenticate with a write-scoped token, and upload to a public Dataset repository:

```bash
python -m pip install --upgrade huggingface_hub
hf auth login
npm run hf:upload -- --repo <owner>/<repo>
```

The token must stay outside the repository. `HF_TOKEN` may be supplied through the shell instead of the saved Hugging Face login. The upload script creates the Dataset when necessary and writes only the prepared pilot under `releases/2026-08-07/`.

Verify every uploaded pilot file against the local manifest and checksum, including byte-range `206` responses and browser CORS on FASTA/GFF3 files:

```bash
npm run hf:verify -- --repo <owner>/<repo>
```

To validate a transparent mirror instead of the official endpoint, add `--endpoint https://hf-mirror.com`. A mirror is accepted only if the same Range, CORS, size, and SHA-256 checks pass.

After verification passes, copy the two URLs printed by the verifier to `.env.local` as `NEXT_PUBLIC_STORAGE_BASE_URL` and `NEXT_PUBLIC_RELEASE_ASSET_BASE_URL`, restart the portal, and test both JBrowse detail pages. This pilot intentionally uploads only two object directories; it is not a complete public release.

For a partial pilot, configure `HF_PILOT_STORAGE_BASE_URL` and `HF_PILOT_ACCESSIONS` instead. Only those accessions are routed through the path-restricted `/api/remote-data/<accession>/<file>` Range proxy; the remaining genomes continue to use local release data. This same-origin proxy is useful when an end-user browser cannot reach Hugging Face directly and never accepts arbitrary upstream URLs or unlisted files.

### Hugging Face complete 1,000-genome release

Phase three uploads the validated release directly from `.data/releases/2026-08-07/` in resumable accession batches. A rerun compares remote LFS SHA-256 or Git blob IDs and uploads only missing or different files. It also replaces the partial pilot markers after all batches succeed.

```bash
npm run hf:upload:release -- --repo <owner>/<repo>
npm run hf:verify:release -- --repo <owner>/<repo>
```

The verifier checks the complete remote inventory, sizes, every LFS SHA-256 or regular Git blob ID, and deterministic FASTA/GFF3 Range and CORS samples. After it passes, configure the complete same-origin proxy:

```env
NEXT_PUBLIC_STORAGE_BASE_URL=/api/remote-data
NEXT_PUBLIC_RELEASE_ASSET_BASE_URL=https://huggingface.co/datasets/<owner>/<repo>/resolve/main/releases/2026-08-07
HF_STORAGE_BASE_URL=https://huggingface.co/datasets/<owner>/<repo>/resolve/main/releases/2026-08-07/objects
```

In complete-release mode, `/api/remote-data` accepts only accessions present in the server catalog and the fixed RAPPTOR asset filenames. The pilot variables are no longer required.
