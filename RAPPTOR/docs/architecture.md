# 架构与代码入口

## 组件关系

```text
浏览器 → Cloudflare Worker（Next.js）
          ├─ D1：目录、认证、票据、额度、任务元数据、通知、访问统计
          ├─ Hugging Face：参考序列、注释、预测轨道
          ├─ Resend：验证码与任务通知
          └─ Docker API → Redis/RQ → 推理 worker → Docker 数据卷
                          └─ 内部回调 → Worker → D1 / 邮件通知
```

Better Auth 运行在 Worker 内。Docker 服务位于 `services/prediction/`，已经实现，
独立于网页构建和发布。模型来源见 [运行时来源](../services/prediction/RUNTIME_PROVENANCE.md)。

## 按功能找代码

| 功能 | 入口 |
| --- | --- |
| 页面和 HTTP 路由 | `src/app/` |
| 基因组目录和 D1 查询 | `src/features/genomes/repository.ts` |
| JBrowse、实验 TSS、统一基因组视图 | `src/features/genome-browser/` |
| Hugging Face 路径和 Pack 映射 | `src/features/storage/` |
| 当前预测界面、票据、参考缓存、任务状态 | `src/features/prediction/` |
| 验证码、会话、发信和通知重试 | `src/features/email-system/` |
| 访问统计和保留清理 | `src/features/usage/` |
| Docker HTTP 和 RQ worker | `services/prediction/src/prediction_service/` |
| 模型推理实现 | `services/prediction/src/rapptor/` |
| Cloudflare 入口与 Cron | `config/cloudflare-worker.mjs` |
| D1 表结构变更 | `database/migrations/` |
| 离线处理、部署和上传工具 | `scripts/` |

`src/generated/` 保存生成的目录快照，随数据发布更新。`.data`、`.next`、
`.open-next`、`.wrangler` 和 `node_modules` 是本地产物。

## 主要请求流程

### 目录与浏览器

`/genomes` 和 `/api/genomes` 使用目录 repository。生产读取 D1；本地默认读取
生成的 JSON。详情页根据 exact accession 或已审核的 GCA/GCF 映射组合预测、注释
和实验 TSS。轨道通过 `/api/remote-data` 或本地数据路由读取，支持 HTTP Range。

### 登录与邮件

`/api/prediction-auth` 调用 Better Auth，使用 D1 保存用户、验证码哈希和会话。
浏览器以 HttpOnly Cookie 保持登录。发码和任务通知共享 D1 日预算；Resend 发信。
接口字段、会话续期和模板入口见 [邮件系统](email-system-integration.zh-CN.md)。

### 在线预测

1. `/predict` 登录后通过 Turnstile 申请一次性票据。
2. `/api/predictions/jobs` 验证输入，必要时准备 Docker 参考 CGR 缓存，再转发任务。
3. Docker 原子消费票据，进入 Redis/RQ 队列；推理 worker 写入数据卷。
4. 浏览器读取受任务 token 保护的状态和产物；Docker 回调 Worker 更新 D1 元数据。
5. 选择邮件通知的任务在终态登记发送；每 5 分钟 Cron 重试待发送邮件。

输入模式和端点见 [接口](prediction-service.md)，参考缓存见 [参考处理](prediction-ncbi-reference.md)。
结果文件由 Docker 保留策略控制，D1 保存业务元数据。

旧 `provider.ts`、`demo-provider.ts`、`remote-provider.ts` 和对应版本化接口仍保留。
当前 `/predict` 使用上述队列流程；开发预览为 `/predict/preview`。
旧 Supabase 实现在 `email-system/supabase.ts` 和 `supabase-route.ts`，当前路由不调用。

### 访问统计与定时任务

中间件过滤请求后，后台写入汇总统计。每日 Cron 清理过期记录；每 5 分钟 Cron
处理通知重试。开关和报表入口见 [访问统计](usage-analytics.md)。

## 修改代码时

- 页面、HTTP 入口放 `src/app`，业务逻辑放对应 `src/features`。
- 多功能共享的 UI 放 `src/components`，共有类型放 `src/types`。
- 模型与队列修改放 `services/prediction`，离线工具放对应 `scripts` 子目录。
- 表结构变更新增编号迁移，保留已有迁移；生产绑定与普通变量维护在 `wrangler.toml`。
