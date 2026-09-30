# 数据制作与发布

本手册面向数据维护者。日常修改网页或邮件系统无需重新制作数据。

生产目录使用 D1 元数据和 Hugging Face 文件；本地开发可以使用生成的 JSON 目录。
运行下面的命令前，准备原始数据及 `samtools`、`bgzip`、`tabix`、`gzip`、`tar`。
Windows 下的离线索引步骤使用 WSL；网页构建要求见 [部署手册](cloudflare-workers-builds.md)。

发布顺序：制作文件 → 校验 → 上传 → 导入 D1 → 验证文件访问 → 激活 release。
发布过程中保留上一个 release，以便回退。

## 初始预测 release 制作

Place `gtdb_selected_data_20260807.tar.gz` one directory above this project, then run:

```bash
npm run data:build
npm run data:validate
```

On Windows, run the build in WSL so the native indexing tools are available:

```bash
cd /path/to/promoter_database_web/RAPPTOR
node scripts/data/build-gtdb-release.mjs --tool-mode native --force
node scripts/data/validate-gtdb-release.mjs
```

To include the stride-50 RAPPTOR model scores, install the offline converter dependencies and pass the directory containing one Parquet file per release accession:

```bash
python3 -m pip install pyarrow pyBigWig
node scripts/data/build-gtdb-release.mjs --tool-mode native --score-root /path/to/prediction_scores_step_50 --force
```

Each Parquet file name must contain its versioned `GCA_...` or `GCF_...` accession. The canonical schema is `Sequence_ID`, `Start`, `End`, `Score`, and `Strand`; RAPPTOR `.sidecar.parquet` files with `Sequence_ID`, `Position`, `Score`, and `Strand` are also accepted, with `Position` interpreted as the 0-based 1 bp anchor start. Scores stay in `[0,1]`, and adjacent anchors on each contig and strand must be 50 bp apart. The builder writes `promoter-scores.plus.bw` and `promoter-scores.minus.bw`; it does not copy the Parquet input into the release. Without `--score-root` (and without an archive directory named `prediction_scores_step_50`), releases remain compatible and omit these optional assets.

Generated large files are written to `.data/releases/2026-08-07/` and ignored by Git. The small application catalog is copied to `src/generated/release-catalog.json`.

Each accession contains:

```text
reference.fa.gz
reference.fa.gz.fai
reference.fa.gz.gzi
predicted-promoters.gff3.gz
predicted-promoters.gff3.gz.tbi
promoter-scores.plus.bw          # when model scores are supplied
promoter-scores.minus.bw         # when model scores are supplied
ncbi-annotations.gff3.gz       # only when available
ncbi-annotations.gff3.gz.tbi   # only when available
metadata.json
```

The release root also contains `catalog.json`, `release.json`, `manifest.tsv`, and `checksums.sha256`.

## 实验 TSS 发布

Experimental releases are built independently from the prediction release. The input directory contains `manifest.tsv` and the normalized per-study BED files; reference, assembly metadata, and optional annotation assets are supplied in a separate per-GCF NCBI asset directory. Write the generated release to a large data volume, not the Git checkout:

```bash
npm run data:experimental:build -- \
  --source /data/TSS_dataset_by_study \
  --ncbi-assets /data/ncbi-experimental-assets \
  --output /data/experimental-tss-releases/2026-08-25 \
  --release 2026-08-25-experimental-tss \
  --release-date 2026-08-25 \
  --pubmed-cache /data/pubmed-experimental-tss.json \
  --asset-base https://huggingface.co/datasets/OWNER/REPO/resolve/main/releases/2026-08-25
npm run data:experimental:validate -- --release /data/experimental-tss-releases/2026-08-25
```

The builder validates the production baseline (98 studies, 90 GCF assemblies, 78 PMIDs, and 440,947 observations), source hashes, 1 bp BED coordinates, reference contigs, and indexes. It writes `catalog.json`, manifests, checksums, PubMed cache data, Hugging Face-ready assets, and staged/activation D1 SQL. Apply `database/migrations/0006_experimental_tss.sql` before importing those SQL files. Activate the release only after upload and Range-request validation; this updates `experimental_portal_state` and never changes the prediction `portal_state`.

The portal combines both active releases at query time. Evidence is merged into one genome row only for an exact accession or an explicitly configured reciprocal GCA/GCF pair whose reference dictionary and checksum were verified. Audit coverage before activation with prediction catalogs or the original Hugging Face batch mappings:

```bash
npm run data:experimental:audit-predictions -- \
  --experimental-catalog /data/experimental-tss-releases/2026-08-25/catalog.json \
  --prediction-catalog /data/prediction-release/catalog.json \
  --prediction-mapping /data/hf-batches/000/input_mapping.tsv \
  --output-dir /data/experimental-tss-releases/2026-08-25/coverage
```

`--prediction-catalog` and `--prediction-mapping` are repeatable. The deterministic JSON and TSV reports distinguish compatible exact matches, explicit reciprocal candidates, missing predictions, reference mismatches, and incomplete metadata. They never match assemblies from organism names or accession number stems. Missing predictions remain visible as experimental-only genomes and can be backfilled in a later RAPPTOR release.

After independently confirming a reciprocal candidate's NCBI pairing, contig dictionary, and reference checksum, deploy the approved records through the server-only `UNIFIED_GENOME_ALIASES_JSON` variable. Exact accessions merge automatically; unconfigured GCA/GCF pairs remain separate and can never be promoted by a browser query.

Raw BED files and generated releases are intentionally ignored by Git.

## Pack 存储与 D1 激活

The production layout is designed for more than 80,000 genomes without creating hundreds of thousands of Hugging Face files. Accessions use the first two hexadecimal characters of SHA-256 as a stable shard. Logical files remain visible in manifests as `objects/<shard>/<accession>/<file>`, while Hugging Face stores immutable aligned packs below each release.

```bash
npm run data:pack -- --source 2026-08-07 --source-release 2026-08-07 --release 2026-08-11
npm run data:pack:validate
npm run data:d1:legacy
npm run hf:plan -- --release 2026-08-11 --repo liurulong/bacterial-promoter-genomes
npm run hf:upload:browser -- --release 2026-08-11
```

For an 80,000-genome release, keep peak disk use near one shard/Pack by planning first. `--plan-only` hashes the source fragments and their zero-filled 4 KiB alignment gaps, writes `pack-plan.json` plus the release manifests/catalog/D1 import, but does not write any `.bin` Pack. Materialize one shard or one Pack immediately before upload:

```bash
npm run data:pack -- --source 2026-08-07 --source-release 2026-08-07 --release 2026-08-11 --plan-only
npm run data:pack:materialize -- --release 2026-08-11 --shard 00
# alternatively: --pack pack-00-000.bin
```

After the uploader has recorded `status: "complete"`, a valid `verifiedAt`, and immutable Hugging Face commit evidence (`commitUrl` and, when present, matching `commitIds`), reclaiming is hash-gated and dry-run by default. Inspect the proposed removal, then explicitly enable deletion. Only `.data/releases/<release>/packs/pack-*.bin` can be removed; source objects and logical paths are never deletion targets.

```bash
npm run hf:reclaim:pack -- --release 2026-08-11 --shard 00
npm run hf:reclaim:pack -- --release 2026-08-11 --shard 00 --delete
```

The browser uploader only connects to the Open Browser CDP port bound on localhost. It discovers `http://[::1]:9223/json/version` by default and also accepts an explicit loopback `--ws-endpoint`. Start a compatible browser with a dedicated profile outside the project and bind its debugging port to loopback only; the uploader connects to that existing session. File traffic therefore uses Open Browser's direct connection; the script never reads or exports cookies or tokens. Resume state is stored in `.data/upload-plans/`, and recreating the plan preserves completed batches whose local hashes and commit URL still match.

When a pending Pack batch references a planned `.bin` that is not present locally, the browser uploader automatically materializes that Pack from `pack-plan.json` before hashing and uploading it. Add `--reclaim-verified-packs` to delete the temporary Pack immediately after the complete Pack-only batch has been verified remotely and recorded in the resume state. Metadata batches and unverified Packs are not reclaimed.

```bash
npm run hf:upload:browser -- --release 2026-08-11 --reclaim-verified-packs
```

The CLI fallback consumes the same upload plan:

```bash
npm run hf:upload:packed:cli -- --release 2026-08-11 --dry-run
```

Full validation checks all 1,000 genomes and 7,312 logical fragments, fragment and Pack SHA-256 values, 4 KiB alignment, non-overlapping offsets, all 256 manifest/catalog shards, and D1 genome INSERT counts. `--quick` skips only rereading all large-file bytes.

D1 is bound as `RAPPTOR_DB`. Apply the migrations from `database/migrations` in order with `npx wrangler d1 migrations apply RAPPTOR_DB --remote`; `0002_feature_catalog.sql` preserves any catalog already created by the original `0001`. Then import the legacy rollback release from `.data/d1-imports/2026-08-07/` and the packed release from `.data/releases/2026-08-11/d1/`. Do not apply `activate.sql` until the Hugging Face release exists and its Pack hashes, D1 counts, API pagination, Range responses, preview deployment, and representative JBrowse pages all pass. Roll back with the legacy `activate-rollback.sql` without deleting either release or any Pack.

Production requires D1; local development defaults to the generated JSON catalog unless `RAPPTOR_CATALOG_BACKEND=d1` is explicitly set. The catalog API never exposes Pack offsets. Only the allowlisted `/api/remote-data/<accession>/<file>` proxy reads the active release mapping and rewrites a single logical Range. D1 import files contain at most 500 genomes each, and the complete 80,000-row catalog is never bundled into Next.js.

The homepage release metrics are a checked-in snapshot in `src/generated/release-summary.json`. This keeps homepage requests static and avoids a D1 read for counts that only change when a release is published. Update that snapshot as part of each release deployment, then deploy the Worker and switch the D1 active release together. Genome lists, filters, details, and biological asset routes remain dynamic and continue to use D1.

For the numeric Hugging Face upload layout, generate the accession-to-batch plan from the sorted metadata TSV. The command writes an auditable `asset-links.tsv`, a compact 81-batch `asset-layout.json`, and a guarded one-row D1 update. Planned batches stay `staged` until all files and JBrowse indexes have been uploaded and verified.

```bash
npm run hf:batch-plan -- --input gtdb_genome_metadata_r214.tsv --output hf-batch-asset-plan
```

## 文件访问与坐标

目录 API 为 `GET /api/genomes`，筛选、排序和分页参数见 [接口说明](prediction-service.md#基因组目录)。
生产文件通过 `/api/remote-data` 访问。若使用独立对象存储，配置
`NEXT_PUBLIC_STORAGE_BASE_URL` 和 `NEXT_PUBLIC_RELEASE_ASSET_BASE_URL`，并开放
GET、HEAD、Range 和站点来源的 CORS。

release 中的 GFF3 使用 1-based、closed 坐标；`promoter_peak` 的起点等于终点。
JBrowse 展示 1-based 位置。实验 TSS 输入的 BED 使用 0-based、half-open 坐标，
不要直接把 BED 坐标当成 GFF3 坐标。模型扫描输出的坐标说明见
[Docker 服务手册](../services/prediction/README.md#sequence-scan-outputs)。

早期逐文件上传流程保留在 [存储试点记录](archive/storage-pilots-2026-08.md)。
