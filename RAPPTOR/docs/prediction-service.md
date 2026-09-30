# 基因组与预测接口

以下是当前网页接口。请求发往 RAPPTOR 同源地址；Docker 内部接口单独列出。
登录、验证码和任务邮件见 [邮件系统](email-system-integration.zh-CN.md)。

## 基因组目录

`GET /api/genomes` 支持 `q`、`domain`、`phylum`、`class`、`order`、`family`、
`genus`、`source`、`annotation`、`sort`、`direction`、`limit`、`cursor`。
`limit` 可取 25、50、100。后续页使用响应返回的游标，游标绑定排序方式。
`annotation=unavailable` 包括缺失或与 assembly 不兼容的注释。
返回字段见 `src/features/genomes/types.ts`，查询规则见 `search-query.ts`。

## 预测请求顺序

1. 登录：`/api/prediction-auth`，浏览器保存会话 Cookie。
2. 完成 Turnstile，申请一次性 Ticket。
3. 使用 Ticket 创建任务，保存返回的 `job_id` 和私密 `access_token`。
4. 使用任务 token 查询状态和下载产物。

### 申请票据

```http
POST /api/prediction-tickets
Content-Type: application/json
```

```json
{"turnstileToken":"<widget token>","modelVersion":"candidate-github-93cf","mode":"predict","bases":100}
```

成功返回 201，字段包含 `ticket`、`expiresAt`、`modelVersion`、`maxBases`、
`inputRequirements`。`predict` 计入目标序列的 100 bp；`genome_scan` 计入目标
FASTA 的碱基数，参考 CGR 不作为额外扫描输入。票据绑定模式、模型和输入限额，
只能消费一次。当前 TTL 和额度以 `wrangler.toml` 为准。

### 创建任务

```http
POST /api/predictions/jobs
Authorization: Ticket <ticket>
Content-Type: application/json
```

```json
{
  "mode": "predict",
  "sequence": "<exactly 100 A/C/G/T bases>",
  "reference_accession": "<versioned catalog accession>",
  "complete_genome": true,
  "strand_mode": "both",
  "notify_by_email": true
}
```

尖括号内容是占位值。`predict` 的 CGR 来源选择 `reference_accession`、完整
`genome_context` 或完整参考 `fasta` 之一。`genome_scan` 用 `fasta` 指定扫描目标；
可另给参考 accession 或完整 context，省略时用完整目标 FASTA 生成 CGR。
`complete_genome:true` 表示调用方确认 CGR 来源完整，并不表示部分扫描目标是完整基因组。

`strand_mode` 为 `both`、`forward` 或 `reverse`；其他扫描字段如 `stride`、
`score_cutoff`、`output_formats` 的支持情况和上限以 Docker `/v1/models/current`
及部署的 schema 为准。完整字段见
[`schemas.py`](../services/prediction/src/prediction_service/schemas.py)。

Worker 扩展字段 `ncbi_accession` 和参考准备过程见 [参考缓存](prediction-ncbi-reference.md)。
`notify_by_email` 为可选 boolean，收件人由已验证的登录身份决定。
Worker 转发前移除该字段，Docker 不处理邮件。

接受任务后通常返回 202，包含 `job_id`、`status`、`access_token`、`model_version`、
`queue` 和 `status_url` 等服务字段。任务已接受后的通知登记失败不撤销任务。

### 状态与产物

| 请求 | 授权 / 用途 |
| --- | --- |
| `GET /api/predictions/jobs/{jobId}` | `X-Job-Token: <access_token>`，读取状态 |
| `POST /api/predictions/jobs/{jobId}/session` | `X-Job-Token`，换取浏览器产物访问 Cookie |
| `GET /api/predictions/jobs/{jobId}/artifacts/{filename}` | 任务 token 或已建立的产物会话；支持 Range |

状态为 `queued`、`running`、`succeeded`、`failed`；查不到的任务可返回 `unknown`。
完成响应包含产物信息与到期时间。任务 token 是访问凭据，不能公开或写入日志。
页面 `/predict/task/{jobId}` 使用现有浏览器凭据或链接中的 `#access=...` 恢复访问。
队列字段见 [队列显示](prediction-queue-ui.md)，可复现样本见 [在线验收](prediction-live-acceptance.md)。

### 错误处理

错误通常包含 `error.code` 和 `error.message`。按 HTTP 状态和 code 处理，保留用户输入。
400 检查输入；401/403 检查登录、票据或 Turnstile；413 减少输入；429 按
`Retry-After` 等待；503 检查配置、D1 或 Docker 连通性。
提交超时且结果不明时先确认是否已创建任务，避免重复扫描。

## Docker 与 Worker 对接

| 接口 | 调用者与用途 |
| --- | --- |
| Docker `POST /v1/jobs` | Worker 转发任务，使用 Ticket |
| Docker `GET /v1/jobs/{job_id}` | 任务状态，使用 `X-Job-Token` |
| Docker `/v1/reference-cache/*` | Worker 或可信同步程序准备参考 CGR，使用服务 Bearer secret |
| Worker `POST /api/internal/prediction-tickets/consume` | Docker 原子消费票据，使用服务 Bearer secret |
| Worker `POST /api/internal/prediction-jobs` | Docker 写入任务事件并触发通知，使用服务 Bearer secret |

回调 JSON 和通知重试规则见邮件指南。Docker 部署与缓存 API 见
[服务手册](../services/prediction/README.md)。结果文件在 Docker 数据卷中；
D1 保存业务元数据，Redis 保存队列和暂态信息。

## 开发与旧接口

本地免登录真实预测使用 [开发票据流程](prediction-local-test.md)。
旧 `/api/predictions` 及 `contractVersion` 分支仍保留；新接入使用上面的队列接口。
早期 R2/MVP 设计保存在 [归档](archive/prediction-service-mvp-2026-08-25.md)。
