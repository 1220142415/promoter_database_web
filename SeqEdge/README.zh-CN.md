# SeqEdge

SeqEdge 是面向 2026-08-07 GTDB 测试数据集的基因组优先型资源门户。网站提供可检索的基因组目录、按 accession 隔离的 JBrowse 2 视图和可复现下载，不把全部启动子峰导入数据库。

## 数据集

- 1,000 个带版本号的 GCA/GCF assembly
- 23,405,141 个 RAPPtor `promoter_peak`，分数均大于 0.9
- 1,000 个 assembly 的 GTDB taxonomy
- 656 个 assembly 下载到 NCBI 注释，344 个明确缺失；29 个跨环状复制原点的注释被规范化为原点两侧分段，用于索引浏览器轨道
- 不包含实验 TSS 数据集

源压缩包没有记录 GTDB release，因此网站只显示数据集版本 `2026-08-07`，不猜测或声称具体 GTDB release。

## 使用流程

1. 在 Genome catalog 中按 accession、物种名或 taxonomy 搜索。
2. 按 phylum、基因组来源或 NCBI 注释可用性筛选。
3. 打开一个 assembly，在 JBrowse 中查看参考序列、预测启动子和可选 NCBI 注释。
4. 下载该 assembly 的索引文件和 metadata。
5. 在 Data & methods 页面查看来源、证据边界、文件格式、manifest 和 checksum。

RAPPtor 预测峰与 NCBI 基因结构注释是不同的信息层。网站不推断启动子对应基因，也不把预测峰写成实验 TSS。

## 环境要求

- Node.js 20 或更高版本
- npm
- Windows 下的 WSL Ubuntu，或原生 Unix 环境
- `samtools`、`bgzip`、`tabix`、`gzip` 和 `tar`

Ubuntu 安装命令：

```bash
sudo apt-get update
sudo apt-get install -y samtools tabix
```

## 构建数据 release

将 `gtdb_selected_data_20260807.tar.gz` 放在本项目上一级目录，然后运行：

```bash
npm run data:build
npm run data:validate
```

Windows 建议直接在 WSL 中运行完整构建：

```bash
cd /mnt/d/科研/promoter/datasetweb/SeqEdge
node scripts/build-gtdb-release.mjs --tool-mode native --force
node scripts/validate-gtdb-release.mjs
```

如需加入 step=50 的 RAPPtor cutoff 前原始分数，先安装离线转换依赖，再传入每个待发布 accession 恰好一个 Parquet 的目录：

```bash
python3 -m pip install pyarrow pyBigWig
node scripts/build-gtdb-release.mjs --tool-mode native --score-root /path/to/prediction_scores_step_50 --force
```

每个 Parquet 文件名必须包含带版本号的 `GCA_...` 或 `GCF_...` accession。标准格式包含 `Sequence_ID`、`Start`、`End`、`Score`、`Strand` 五列；RAPPtor 的 `.sidecar.parquet` 格式 `Sequence_ID`、`Position`、`Score`、`Strand` 也可以直接使用，其中 `Position` 按 0-based 的 1 bp anchor 起点解释。score 保持在 `[0,1]`，同一 contig/strand 的相邻 anchor 必须相差 50 bp。构建器生成 `promoter-scores.plus.bw` 和 `promoter-scores.minus.bw`，不会把 Parquet 复制进 release。未传 `--score-root` 且压缩包内没有 `prediction_scores_step_50` 目录时，旧 release 仍可正常构建，这两个可选资产为 `null`。

大文件输出到 `.data/releases/2026-08-07/`，并被 Git 忽略。供网站构建使用的小型 catalog 会复制到 `src/generated/release-catalog.json`。

每个 accession 的对象目录包含：

```text
reference.fa.gz
reference.fa.gz.fai
reference.fa.gz.gzi
predicted-promoters.gff3.gz
predicted-promoters.gff3.gz.tbi
promoter-scores.plus.bw          # 提供原始分数时生成
promoter-scores.minus.bw         # 提供原始分数时生成
ncbi-annotations.gff3.gz       # 仅可用时存在
ncbi-annotations.gff3.gz.tbi   # 仅可用时存在
metadata.json
```

release 根目录还包含 `catalog.json`、`release.json`、`manifest.tsv` 和 `checksums.sha256`。

## 本地运行

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。本地数据路由只允许固定 accession 和文件名，并支持 GET、HEAD 与 byte range。

`npm start` 从项目目录启动 standalone server。若将 standalone bundle 复制到其他位置，需要挂载 release 目录并设置 `LOCAL_DATA_ROOT` 和 `LOCAL_RELEASE_ROOT`，或者改用下面的两个对象存储地址。

## 基因组目录 API

基因组目录首屏的 25 条记录由服务端直接渲染。搜索、taxonomy/source 筛选、注释可用性、排序和后续分页均通过 `GET /api/genomes` 完成，浏览器不再下载完整 catalog。

接口支持 `q`、`domain`、`phylum`、`class`、`order`、`family`、`genus`、`source`、`annotation`、`sort`、`direction`、`limit` 和 `cursor`。`limit` 只能是 25、50 或 100。分页游标是不透明值，并与当前排序字段和方向绑定。`annotation=unavailable` 同时包含 NCBI 注释缺失和与 assembly 不兼容的记录。

服务端通过 `GenomeCatalogRepository.search()` 和 `GenomeCatalogRepository.getByAccession()` 访问目录。本地开发读取并缓存 `src/generated/release-catalog.json`，生产环境通过 `SEQEDGE_DB` binding 查询 D1。promoter 数量和文件引用来自默认 `feature_sets` 记录，真实基因组区间仍保存在带索引的 GFF3 文件中。

## 对象存储部署

将 `.data/releases/2026-08-07/objects/` 上传到对象存储，并设置：

```env
NEXT_PUBLIC_STORAGE_BASE_URL=https://storage.example.org/seqedge/2026-08-07
NEXT_PUBLIC_RELEASE_ASSET_BASE_URL=https://storage.example.org/seqedge/2026-08-07
```

对象存储需要允许 GET、HEAD、Range，并通过 CORS 允许网站域名。release 根目录的 JSON、TSV 和 checksum 文件也应上传。

### Hugging Face 两个基因组试运行

第二阶段先使用 `GCA_000411415.1`（有 NCBI annotation）和 `GCA_000421325.1`（无 annotation）。先整理上传目录，不修改原 release：

```bash
npm run hf:prepare
```

安装 Hugging Face 官方客户端，使用具有写入权限的 token 登录，然后上传到公开 Dataset 仓库：

```bash
python -m pip install --upgrade huggingface_hub
hf auth login
npm run hf:upload -- --repo <owner>/<repo>
```

token 必须保存在项目之外。也可以在 shell 中提供 `HF_TOKEN`，不使用本机保存的 Hugging Face 登录。上传脚本会在需要时创建 Dataset，并且只把准备好的试运行文件写入 `releases/2026-08-07/`。

上传后逐文件核对本地 manifest、文件大小和 SHA-256，同时验证 FASTA/GFF3 的 `206 Partial Content` 和浏览器 CORS：

```bash
npm run hf:verify -- --repo <owner>/<repo>
```

需要验证透明镜像时，可增加 `--endpoint https://hf-mirror.com`。只有同样通过 Range、CORS、文件大小和 SHA-256 检查的镜像才能用于 JBrowse。

验证通过后，把命令输出的两个 URL 写入 `.env.local` 的 `NEXT_PUBLIC_STORAGE_BASE_URL` 和 `NEXT_PUBLIC_RELEASE_ASSET_BASE_URL`，重启网站，再检查两个代表性详情页的 JBrowse。试运行只上传两个 object 目录，不代表完整 release 已公开。

只做部分试运行时，应改为配置 `HF_PILOT_STORAGE_BASE_URL` 和 `HF_PILOT_ACCESSIONS`。只有列出的 accession 会通过受限的 `/api/remote-data/<accession>/<file>` Range 代理读取远端文件，其余基因组继续使用本地 release。当终端用户浏览器不能直接访问 Hugging Face 时，这个同源代理可以保证 JBrowse 正常工作；它不接受任意远端 URL 或未列入白名单的文件。

### Hugging Face 完整 1,000 基因组 release

第三阶段直接从 `.data/releases/2026-08-07/` 按 accession 分批上传已校验的完整 release。重复执行时会比较远端 LFS SHA-256 或 Git blob ID，只上传缺失或发生变化的文件；所有批次成功后会移除已经过时的试运行标记。

```bash
npm run hf:upload:release -- --repo <owner>/<repo>
npm run hf:verify:release -- --repo <owner>/<repo>
```

校验器会核对完整远端文件清单、大小、每个 LFS SHA-256 或普通 Git blob ID，并对确定性抽样的 FASTA/GFF3 检查 Range 和 CORS。通过后配置完整 release 的同源代理：

```env
NEXT_PUBLIC_STORAGE_BASE_URL=/api/remote-data
NEXT_PUBLIC_RELEASE_ASSET_BASE_URL=https://huggingface.co/datasets/<owner>/<repo>/resolve/main/releases/2026-08-07
HF_STORAGE_BASE_URL=https://huggingface.co/datasets/<owner>/<repo>/resolve/main/releases/2026-08-07/objects
```

完整 release 模式下，`/api/remote-data` 只接受服务端目录中存在的 accession 和固定的 SeqEdge 文件名，不再需要 pilot 环境变量。

## 验证

```bash
npm run lint
npm test
npm run test:data
npm run build
npm run test:e2e
npm run build:cf
```

验证通过后，用下面的命令部署到 Cloudflare Workers：

```bash
npm run deploy:cf
```

使用 Workers Builds 时，Build command 设置为 `npm run build:cf`，Deploy
command 设置为 `npx @opennextjs/cloudflare deploy`。在 Cloudflare 构建环境中设置
`NEXT_PUBLIC_STORAGE_BASE_URL=/api/remote-data`，并将当前 release URL 设置为
`NEXT_PUBLIC_RELEASE_ASSET_BASE_URL`。

完整数据校验会检查集合数量、accession 对应关系、feature 类型、分数和链范围、FASTA/GFF3 坐标、BGZF/Tabix 索引、manifest 以及 SHA-256。

### 在 WSL 中构建 standalone 与 Cloudflare 产物

Windows 环境下应使用由 Linux 安装的依赖在 WSL 内执行生产构建和 Cloudflare 构建。推荐使用带有独立 `node_modules` 的 WSL 原生 checkout；Windows 安装的依赖树不包含 Linux 所需的 Lightning CSS/SWC 原生二进制文件。

```bash
npm ci
npm run build
npm run build:cf
```

如果 checkout 位于 `/mnt/d` 并由 Windows 和 WSL 共用，在 WSL 中执行 `npm ci` 会把依赖树替换为 Linux 版本；之后若要再次用 Windows Node.js，应在 Windows 中重新执行 `npm ci`。

Next.js 的 output tracing 会在三个仅供本地使用的路由（`/api/local-data`、`/api/local-region` 和 `/api/local-release`）中排除 `.data/**`。如果 standalone 产物里仍出现 `.data` 目录，postbuild 会直接失败，防止把 1,000 个基因组或未来的 Pack 意外复制进部署包。生产构建必须使用 WSL：Next.js 15 的 trace 排除匹配器不能可靠处理 Windows 反斜杠路径，保护检查会拒绝这种超大的 Windows 产物。该配置只影响生产打包，本地开发仍可正常读取 `.data`。如果 standalone 部署确实需要这些本地路由，应单独挂载 release，并设置 `LOCAL_DATA_ROOT` 和 `LOCAL_RELEASE_ROOT`；使用 D1/Hugging Face 的生产部署无需挂载本地 release。

## 单仓库 Pack release 与 D1

生产布局面向 8 万以上基因组，避免在 Hugging Face 产生几十万个独立文件。accession 使用 SHA-256 前两位作为稳定 shard。manifest 中的逻辑路径仍为 `objects/<shard>/<accession>/<file>`，Hugging Face 实际保存 release 下的不可变对齐 Pack。

```bash
npm run data:pack -- --source 2026-08-07 --source-release 2026-08-07 --release 2026-08-11
npm run data:pack:validate
npm run data:d1:legacy
npm run hf:plan -- --release 2026-08-11 --repo liurulong/bacterial-promoter-genomes
npm run hf:upload:browser -- --release 2026-08-11
```

构建 8 万基因组 release 时，可以把磁盘峰值控制在一个 shard/Pack 左右。先使用 `--plan-only`：它会校验并读取源片段，把 4 KiB 对齐空隙按零字节计入 Pack SHA-256，生成 `pack-plan.json`、manifest、catalog 和 D1 import，但不会写出任何 `.bin` Pack。上传前再按单个 shard 或单个 Pack 临时物化：

```bash
npm run data:pack -- --source 2026-08-07 --source-release 2026-08-07 --release 2026-08-11 --plan-only
npm run data:pack:materialize -- --release 2026-08-11 --shard 00
# 也可使用：--pack pack-00-000.bin
```

只有上传状态同时记录 `status: "complete"`、合法 `verifiedAt` 和不可变 Hugging Face commit 证据（`commitUrl`，以及存在时与之匹配的 `commitIds`），且本地 Pack 的长度和 SHA-256 仍与不可变计划一致时，回收器才允许删除。默认只是 dry-run；确认输出后必须显式加 `--delete`。回收目标被限制在 `.data/releases/<release>/packs/pack-*.bin`，不会删除源对象或逻辑路径。

```bash
npm run hf:reclaim:pack -- --release 2026-08-11 --shard 00
npm run hf:reclaim:pack -- --release 2026-08-11 --shard 00 --delete
```

浏览器上传器只连接绑定在本机的 Open Browser CDP 端口，默认探测 `http://[::1]:9223/json/version`；也可以用 `--ws-endpoint` 显式传入本机调试地址。指定程序为 `D:\open brower\open_browser\Chrome\Application\open_browser.exe`，应使用项目外的独立 profile，并只把调试端口绑定到 loopback。文件流量使用 Open Browser 的直连网络；脚本不会读取或导出 cookie/token。断点状态保存在 `.data/upload-plans/`，重新生成计划会保留本地 hash 未变化且已有 commit URL 的完成批次。

待上传的 Pack 批次如果引用了本地尚不存在、但已记录在 `pack-plan.json` 中的 `.bin`，浏览器上传器会在校验和上传前自动物化该 Pack。加上 `--reclaim-verified-packs` 后，只有远端校验通过并已写入断点状态的纯 Pack 批次才会立即删除对应的临时 Pack；metadata 批次和未经验证的 Pack 不会被回收。

```bash
npm run hf:upload:browser -- --release 2026-08-11 --reclaim-verified-packs
```

CLI 回退读取同一个上传计划：

```bash
npm run hf:upload:packed:cli -- --release 2026-08-11 --dry-run
```

完整校验逐一核对 1,000 个 genome、7,312 个逻辑片段、Pack 片段 SHA-256、Pack SHA-256、4 KiB 对齐、无重叠 offset、256 个 manifest/catalog 分片及 D1 INSERT 数量；`--quick` 只跳过重新读取所有大文件字节。

D1 binding 固定为 `SEQEDGE_DB`。先应用 `migrations/0001_seqedge_catalog.sql`，再导入 `.data/d1-imports/2026-08-07/` 中的 legacy 回滚 release 和 `.data/releases/2026-08-11/d1/` 中的新 release。两者都先保持 inactive；只有 Pack SHA-256、D1 数量、API 分页、Range、preview 和代表性 JBrowse 页面全部通过后，才执行新 release 的 `activate.sql`。回滚时执行 legacy 的 `activate-rollback.sql`，不删除任何 release 或 Pack。

生产环境强制 D1；本地默认继续读取生成的 JSON catalog，只有显式设置 `SEQEDGE_CATALOG_BACKEND=d1` 才使用 D1。目录 API 不返回 Pack offset；只有受限的 `/api/remote-data/<accession>/<file>` 代理从 active release 查询映射并重写单段 Range。8 万规模仍按每个 D1 SQL 分片最多 500 个 genome 构建，不把完整 catalog 打入 Next.js bundle。

## 访问统计

访问统计默认关闭，只有显式设置 `SEQEDGE_ANALYTICS=on` 才开始收集。默认仅按国家汇总，用于说明部署在全球哪些地方被使用；城市级统计必须显式设置 `SEQEDGE_ANALYTICS_PRECISION=city`。在 Cloudflare 上，位置直接来自边缘的 `request.cf`，不调用第三方 IP 定位服务。系统不存储 IP 地址或 User-Agent：每个请求只保留粗粒度位置和一个不可反查的访客标识，该标识由地址、User-Agent 与随机的 UTC 当日盐值生成。每次成功统计请求或后台读取都会删除早于今天和昨天的盐；部署空闲时清理也会等待。

API 请求、基因组 Range 请求、静态资源、路由预取、后台页面本身以及已知爬虫都不计入。写入通过 Cloudflare 后台任务在响应发出之后执行，因此统计不会拖慢任何页面。「浏览量」指一次完整的页面加载；应用内用 Next.js 路由跳转产生的是 RSC 请求，与路由为每个可见链接发起的预取无法区分，因此宁可少算也不重复计数。访客数不受影响。

先应用一次迁移、显式开启收集，再配置后台账号：

```bash
npx wrangler d1 migrations apply SEQEDGE_DB --remote
npx wrangler secret put SEQEDGE_ANALYTICS
npx wrangler secret put SEQEDGE_ANALYTICS_USERNAME
npx wrangler secret put SEQEDGE_ANALYTICS_PASSWORD
```

`SEQEDGE_ANALYTICS` 的值应设为 `on`。后台账号只控制报表访问权限，不会自动开启收集。

随后 `/admin/usage` 提供世界地图、国家表、Top 城市、Top 页面和每日趋势，可切换 7 天、30 天、90 天、12 个月和全部时间。`/api/admin/usage` 返回同一份报表的 JSON；加上 `?format=csv&dataset=countries|cities|paths|daily` 导出 CSV。两个入口在账号未配置前一律返回 404，配置之后由 HTTP Basic 认证保护。

| 变量 | 作用 |
| --- | --- |
| `SEQEDGE_ANALYTICS=on` | 显式开启收集。未设置或其他值均保持关闭；已记录数据仍可查看。 |
| `SEQEDGE_ANALYTICS_USERNAME`、`SEQEDGE_ANALYTICS_PASSWORD` | 显示并保护后台面板。未设置时所有 admin 路径返回 404。 |
| `SEQEDGE_ANALYTICS_PRECISION=city` | 显式开启城市、地区和经纬度记录；默认只记录国家。 |
| `SEQEDGE_ANALYTICS_RETENTION_DAYS` | 保留天数，默认 400 天；过期行在下一次成功统计请求或后台读取时清理。 |
| `SEQEDGE_ANALYTICS_TRUST_PROXY_HEADERS=on` | 非 Cloudflare 部署可显式信任受控反向代理写入的 IP/位置头；直连或不可信流量不要开启。 |

地图是构建期产物：`npm run analytics:map` 用 Natural Earth 1:110m 地理数据（公有领域，经 `world-atlas` 提供）重新生成 `src/generated/world-map.json`。投影在构建时完成，页面在服务端渲染为内联 SVG，因此后台面板不引入任何前端地图库，也不违反门户的 CSP。

Cloudflare 提供的地址和 `request.cf` 默认可信。非 Cloudflare 环境下，只有设置 `SEQEDGE_ANALYTICS_TRUST_PROXY_HEADERS=on` 才读取转发 IP 和位置请求头，而且只应在受控代理会覆盖这些请求头时开启；否则位置记为未知。每日访客数是近似值：同一地址与 User-Agent 组合在每个 UTC 日只计一次，时间范围内的访客总数是各日值之和。清理由请求触发，因此无流量时不承诺在某个墙上时间准时删除。

## 坐标约定

release GFF3 保留 1-based closed 坐标。RAPPtor 峰是 start 与 end 相等的点特征。JBrowse 也显示 1-based 位置。本门户不生成 BED，也不做数据库坐标转换。
