# 本地免登录真实预测

`npm run prediction:local:dev` 仅监听 `127.0.0.1`，页面显示“本地真实预测测试”。本机调用原有在线 `candidate-github-93cf` 模型。生产站保留部署时已有的访问模式和人机验证，模型服务继续校验真实一次性票据。

2026-09-07 管理员授权和测试票据接口部署已完成，本地免邮箱提交已实测连通。当前生产使用原有 `RAPPTOR_PREDICTION_ACCESS_MODE=ip`；本次没有改动该模式或模型服务。真实结果和尚未通过的双链验收见 [验收记录](prediction-local-test-acceptance-2026-09-07.md)。

## 一次配置

使用 Node 22.18+，在 RAPPTOR 目录执行：

```sh
npm run prediction:local:setup
```

该命令在忽略的 `.env.prediction-local` 生成专用 256-bit 密钥，保留已有配置。该文件仅由本地启动命令读取，不会被普通 Next 生产构建自动加载。浏览器、公开报告和模型服务均不会收到开发密钥。

Cloudflare 管理账号需要对现有 `rapptor` Worker 和 `seqedge-catalog` D1 有权限。先完成网站发布候选的 `npm ci`、检查、构建和预览，再使用现有部署流程发布新接口 `/api/internal/prediction-test-tickets`，保留远端现有变量、Secrets、路由和 D1 绑定。首次使用 Wrangler 时运行 `npx wrangler login`，然后：

```sh
npm run prediction:local:publish-key
npm run prediction:local:dev
```

Wrangler OAuth 会自动追加 `offline_access`，用于保存可刷新的管理授权；仅通过 `--scopes` 不能省略。管理员未同意该授权时，保留本地配置并停止远端步骤。本次用户后来明确授权，并完成浏览器确认及 Wrangler 凭据保存。

本次发布采用最小追加方式：下载当前 Worker 模块及设置，将已有内部 route 用 `scripts/prediction/build-ticket-overlay.mjs` 编译为独立模块，以原部署为基础上传新版本，保留原模块字节、资产、绑定和已有 Secrets。该入口复用 `route.ts` 和 `tickets.ts`，没有复制另一套签发 SQL。Cloudflare 版本预览通过鉴权、D1、输入边界及原页面/资产校验后才激活；未用本地整站覆盖已更新的线上源码。后续整站部署前须先同步线上公开提交逻辑。

`publish-key` 仅写入已有 Worker 的 `RAPPTOR_LOCAL_TEST_SECRET`，通过标准输入传递，不写命令行。它不会修改现有 `RAPPTOR_PREDICTION_SERVICE_SECRET`、Docker 配置、Supabase 或 Resend。无需新建用户或发送邮件。上线前核验远端具有原有票据迁移 `0008` 和 `0011`；本功能没有新增 schema migration。

本地文件默认包含：

| 配置 | 默认值 |
| --- | --- |
| `RAPPTOR_DEPLOYMENT_ENV` | `local` |
| `RAPPTOR_PREDICTION_LOCAL_TEST` | `on` |
| `NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST` | `on` |
| `RAPPTOR_LOCAL_TEST_ORIGIN` | `http://127.0.0.1:3000` |
| `RAPPTOR_LOCAL_TEST_TICKET_ORIGIN` | `https://rapptor.duolalab.qzz.io` |
| `RAPPTOR_PREDICTION_SERVICE_URL` | `https://4090server.duolalab.qzz.io` |
| `RAPPTOR_PREDICTION_MODEL_VERSION` | `candidate-github-93cf` |
| `RAPPTOR_LOCAL_TEST_SECRET` | 本机随机生成；不公开 |

本地模式还要求 `NODE_ENV=development`、实际 Host 为回环地址且端口匹配。写入请求要求同源 `Origin`。远端 URL、跨站请求及矛盾的代理头均无法启用免登录分支。`localhost` 和 `127.0.0.1` 均可打开该端口；不能通过公网反向代理或隧道暴露此开发服务。

## 请求与配额

1. 页面验证真实序列后，请求本地 `/api/prediction-tickets`。
2. 本地后端持开发密钥向远端内部接口请求真实票据。内部接口先校验密钥，再访问 D1；无密钥返回 404，错误密钥返回 401。
3. D1 使用原有一次性票据表，只保存票据哈希。全部开发请求共享独立配额标识，无法通过换 IP 或轮换密钥重置配额。沿用线上模型、每任务 6,000,000 bp、每分钟 2 张票据、每日 12,000,000 基因组 bp 和 120 秒有效期。
4. 本地 `/api/predictions/jobs` 将票据和真实输入发送原有模型服务。该服务继续通过既有内部消费接口原子校验过期、重复使用、模型身份和实际输入大小。本地任务不创建用户、预留用户每日配额或登记邮件通知。
5. 原有访问令牌保护任务状态和产物。独立测试接口 GET 仅检查配置与 D1 表，不生成票据或消耗配额。页面可重新检查可用性而不清除输入。

短序列任务的计费输入包含完整 CGR 基因组，合计 4,641,752 bp。基因组任务为 4,641,652 bp；每次签发基因组票据都会占用开发票据的每日碱基额度，包括签发后未使用的票据。分钟限额遵循现有实现。

## 真实验收和停用

启动本地服务后，直接点击两个真实示例的预测按钮，或运行 `npm run test:prediction:live`。独立验收器在每个新任务提交前自动请求票据，通过本地任务接口提交，并保持原有运行目录的恢复语义；正常测试和 CI 不会运行在线推理。详见 [真实预测验收](prediction-live-acceptance.md)。

关闭本地 `RAPPTOR_PREDICTION_LOCAL_TEST` 并重启，即恢复普通提交行为。执行 `npx wrangler secret delete RAPPTOR_LOCAL_TEST_SECRET --name rapptor` 可停用远端开发入口；已签发的票据至多在当前 TTL 内继续有效。生产用户登录和已有任务访问不受影响。
