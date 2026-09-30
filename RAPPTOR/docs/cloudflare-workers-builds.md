# 网页部署与运维

## 当前配置

代码仓库：`1220142415/promoter_database_web`，正式分支：`main`，应用目录：`RAPPTOR/`。
生产站点：`https://rapptor.xulab.science`。

Cloudflare 账户、Worker、路由、D1 ID、普通变量和 Cron 以
[`wrangler.toml`](../wrangler.toml) 为准，避免在文档里维护第二份配置。
当前 Worker 为 `rapptor`，D1 binding 为 `RAPPTOR_DB`，库名为 `seqedge-catalog`。

网页使用 Node.js 22.18+。Cloudflare bundle 在 Linux、WSL 或 Linux CI 构建；
Windows 可以开发和运行普通 Next.js 构建。

## 发布步骤

在 `RAPPTOR/` 执行。先确认发布分支和目标账户，然后安装锁定依赖：

```bash
npm ci
npx wrangler whoami
```

### 1. 数据库

```bash
npx wrangler d1 migrations list RAPPTOR_DB --remote
```

核对迁移记录和实际表结构，确认哪些迁移尚未应用。当前认证依赖 `0018`、`0019`；
参考缓存依赖 `0015`、`0016`。过去若用 `d1 execute --file` 直接执行过迁移，
列表可能仍显示待应用：先核实并协调迁移记录，不能重复执行包含 `ALTER TABLE` 的文件。
对于按 Wrangler 迁移记录管理、尚未应用的迁移，执行：

```bash
npx wrangler d1 migrations apply RAPPTOR_DB --remote
```

### 2. 配置

构建环境需要两个公开值。可放在忽略的 `.env.local` 或 CI 构建变量中：

```dotenv
NEXT_PUBLIC_STORAGE_BASE_URL=/api/remote-data
NEXT_PUBLIC_RELEASE_ASSET_BASE_URL=https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes/resolve/main
```

这些值必须与已发布的数据集一致。Worker 运行时变量不能代替构建环境变量。
生产普通变量编辑 `wrangler.toml`；密钥通过交互式 `wrangler secret put` 设置：

| Secret | 用途 |
| --- | --- |
| `BETTER_AUTH_SECRET` | 认证与会话，独立随机值，至少 32 字符 |
| `RESEND_API_KEY` | 已验证域名的发信权限 |
| `RAPPTOR_TURNSTILE_SECRET` | 人机验证 |
| `RAPPTOR_PREDICTION_SERVICE_SECRET` | Docker 回调、票据消费、通知加密 |
| `RAPPTOR_PREDICTION_IP_HASH_SECRET` | IP 限流哈希 |

```bash
npx wrangler secret put BETTER_AUTH_SECRET
```

其他密钥以相同方式逐项设置。Docker 中的 `RAPPTOR_TICKET_SERVICE_SECRET` 必须与
Worker 的 `RAPPTOR_PREDICTION_SERVICE_SECRET` 一致；轮换前处理待发送通知。
邮件配置见 [邮件系统](email-system-integration.zh-CN.md)，统计后台配置见 [访问统计](usage-analytics.md)。
`.env.deploy.example` 是配置参考；`deployment:email` 和 `deployment:configure` 仍用于旧 Supabase。

### 3. 构建与发布

```bash
npm run build:cf
npx @opennextjs/cloudflare deploy
```

`build:cf` 顺序执行 ESLint、TypeScript、Vitest、存储环境检查和 OpenNext 构建。
`npm run deploy:cf` 会重新执行构建后发布；已有当前提交的 bundle 时可用上面的 deploy 命令。

### 4. 发布后检查

查看部署版本与日志，确认首页、目录、基因组轨道和登录入口可访问。
核对 Cookie 登录/登出、代表性文件的 Range 响应和预测服务连通性。
真实发信或推理验收分别按邮件指南和 [在线验收](prediction-live-acceptance.md) 执行。

## GitHub 自动构建

如果启用 Workers Builds，在控制台核对以下设置：

| 设置 | 值 |
| --- | --- |
| 仓库 / 分支 | `1220142415/promoter_database_web` / `main` |
| 根目录 | `/RAPPTOR` |
| 构建命令 | `npm run build:cf` |
| 部署命令 | `npx @opennextjs/cloudflare deploy` |
| Node | 22.18+ |

设置构建变量后推送提交或手动重建。是否已连接以控制台为准；仅推送 Git 不等于部署完成。

## 常见故障

| 现象 | 处理 |
| --- | --- |
| 找不到 `package.json` | 把根目录设为 `/RAPPTOR` |
| 缺少 `NEXT_PUBLIC_STORAGE_BASE_URL` | 配置构建环境变量 |
| Windows 缺少 `open-next.config.edge.mjs` | 换 Linux / WSL 构建，使用 Node 22.18+ |
| D1 字段已存在但迁移待执行 | 检查是否曾直接执行 SQL，核对实际结构及迁移记录 |
| Hugging Face 文件 404 | 检查已上传批次、活动 release 和 URL；不要重建数据库 |
| 登录或发信失败 | 按邮件指南检查 Secret、D1 表、发件域名和发送日志 |

Docker 推理服务的部署、数据卷和模型挂载见 [服务手册](../services/prediction/README.md)。
