# 本地免登录真实预测

`npm run prediction:local:dev` 仅监听 `127.0.0.1`，页面显示“本地真实预测测试”。
生产站使用 `email` 模式；本地开发票据独立于用户登录与额度，模型服务仍校验真实一次性票据。

## 一次配置

使用 Node 22.18+，在 RAPPTOR 目录执行：

```sh
npm run prediction:local:setup
```

该命令在忽略的 `.env.prediction-local` 生成专用 256-bit 密钥，保留已有配置。该文件仅由本地启动命令读取。
编辑此文件，把 `RAPPTOR_LOCAL_TEST_TICKET_ORIGIN` 改为 `https://rapptor.xulab.science`；脚本的旧默认地址仍是 `rapptor.duolalab.qzz.io`。

Cloudflare 管理账号需要对 `rapptor` Worker 和 `seqedge-catalog` D1 有权限，并确认当前版本包含 `/api/internal/prediction-test-tickets`。网页发布步骤见 [部署手册](cloudflare-workers-builds.md)。登录 Wrangler 后执行：

```sh
npm run prediction:local:publish-key
npm run prediction:local:dev
```

`publish-key` 将开发密钥写入 Worker 的 `RAPPTOR_LOCAL_TEST_SECRET`，通过标准输入传递。
远端需要票据迁移 `0008` 和 `0011`。早期 overlay 发布方式和实测结果保存在
[历史验收](archive/prediction-local-test-acceptance-2026-09-07.md)。

配置参考（远端限额以 `wrangler.toml` 为准）：

| 配置 | 值 |
| --- | --- |
| `RAPPTOR_DEPLOYMENT_ENV` | `local` |
| `RAPPTOR_PREDICTION_LOCAL_TEST` | `on` |
| `NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST` | `on` |
| `RAPPTOR_LOCAL_TEST_ORIGIN` | `http://127.0.0.1:3000` |
| `RAPPTOR_LOCAL_TEST_TICKET_ORIGIN` | 改为 `https://rapptor.xulab.science` |
| `RAPPTOR_LOCAL_TEST_TICKETS_PER_MINUTE` | 远端内部测试专用；当前部署为 `20` |
| `RAPPTOR_LOCAL_TEST_GENOME_SCANS_PER_DAY` | 远端内部测试专用；当前部署为 `20` |
| `RAPPTOR_LOCAL_TEST_BASES_PER_DAY` | 远端内部测试专用；当前部署为 `100000000` |
| `RAPPTOR_PREDICTION_SERVICE_URL` | `https://rapptor_server.duolalab.qzz.io` |
| `RAPPTOR_PREDICTION_MODEL_VERSION` | `candidate-github-93cf` |
| `RAPPTOR_LOCAL_TEST_SECRET` | 本机随机生成；不公开 |

本地模式还要求 `NODE_ENV=development`、实际 Host 为回环地址且端口匹配。写入请求要求同源 `Origin`。远端 URL、跨站请求及矛盾的代理头均无法启用免登录分支。`localhost` 和 `127.0.0.1` 均可打开该端口；不能通过公网反向代理或隧道暴露此开发服务。

## 请求与配额

1. 页面验证真实序列后，请求本地 `/api/prediction-tickets`。
2. 本地后端持开发密钥向远端内部接口请求真实票据。内部接口先校验密钥，再访问 D1；无密钥返回 404，错误密钥返回 401。
3. D1 使用原有一次性票据表，只保存票据哈希。全部开发请求共享独立配额标识，无法通过换 IP 或轮换密钥重置配额。内部入口沿用线上模型、每任务 6,000,000 bp 和 120 秒有效期，但使用独立的每分钟 20 张票据、每日 20 个基因组任务和每日 100,000,000 基因组 bp 限额；公开入口仍使用原有正式配额。
4. 本地 `/api/predictions/jobs` 将票据和真实输入发送原有模型服务。该服务继续通过既有内部消费接口原子校验过期、重复使用、模型身份和实际输入大小。本地任务不创建用户、预留用户每日配额或登记邮件通知。
5. 原有访问令牌保护任务状态和产物。独立测试接口 GET 仅检查配置与 D1 表，不生成票据或消耗配额。页面可重新检查可用性而不清除输入。

短序列样本的计费输入为目标 100 bp，参考 CGR 不额外计费。完整基因组样本为
4,641,652 bp。开发票据签发时计入其独立日预算，包括签发后未使用的票据。

## 真实验收和停用

启动本地服务后，直接点击两个真实示例的预测按钮，或运行 `npm run test:prediction:live`。独立验收器在每个新任务提交前自动请求票据，通过本地任务接口提交，并保持原有运行目录的恢复语义；正常测试和 CI 不会运行在线推理。详见 [真实预测验收](prediction-live-acceptance.md)。

关闭本地 `RAPPTOR_PREDICTION_LOCAL_TEST` 并重启，即恢复普通提交行为。执行 `npx wrangler secret delete RAPPTOR_LOCAL_TEST_SECRET --name rapptor` 可停用远端开发入口；已签发的票据至多在当前 TTL 内继续有效。生产用户登录和已有任务访问不受影响。
