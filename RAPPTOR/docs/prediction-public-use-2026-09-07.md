# 现有线上入口免邮箱登录实测 — 2026-09-07

现有生产页面已通过真实浏览器完成免邮箱登录提交。此路径使用现有公开票据接口和 Turnstile；本次人机验证自动通过。未执行 Cloudflare 管理员登录、发布、远端配置修改或模型服务重启。本地免验证测试入口仍未部署，不能与本次公开入口实测混为一谈。

入口：https://rapptor.duolalab.qzz.io/predict

## 已完成的真实任务

| 项目 | 实测值 |
| --- | --- |
| 任务 ID | `b531b28252264baabde0850c17695d51` |
| 结果页面 | `/predict/task/b531b28252264baabde0850c17695d51`，访问仍受该浏览器的任务凭据保护 |
| 状态 | 页面显示 `Live task`、`Result ready`、100%；刷新恢复同一任务 |
| 模型 | 页面显示 `candidate-github-93cf`，仍是候选模型 |
| 输入 | `NC_000913.3` 正链 100001–100100，1-based inclusive，100 bp |
| 输入 SHA-256 | `1f22c64bb7b35b5f9d9abb71824045d7b803e96c9a8061f01e00a72311d5b772` |
| CGR 背景 | 上传完整 `GCF_000005845.2` 参考 FASTA，页面结果确认 4,641,652 bp |
| FASTA SHA-256 | `53bb6a51b6e92139ced1e38f74b7938781027c52200922ff03718c2237d23bb4`，上传前重新核对 |
| 页面参数 | Both strands、threshold 0.90、stride 1 bp |
| 下载产物 | `scores.json`，133 字节 |
| 产物 SHA-256 | `ae9eacb44d4b3989f34b9a4ae1a0692ce07a3c679071c64e4e2c98357754bd0e` |
| 实际分数 | 正链 `0.0058243670500814915` |
| 产物有效期 | 页面显示至 2026-09-08 15:08:42（本地时区 Asia/Shanghai） |

下载的真实 `scores.json` 仅包含一条正链记录：`sequence_id=target_sequence`、`window_start_0based=0`、`anchor_position_0based=80`。虽然页面参数显示 Both strands，文件没有反链记录，因此双链验收未通过；这不是仅凭页面即可判定的展示遗漏。本次未取得实际请求体或服务 summary，尚不能确定问题在请求适配还是服务推理路径。

本次只证明真实 100 bp 任务经现有公开流程成功，未完成完整基因组扫描、9,283,106 个窗口、基因组轨道与 Range 验收。完整基因组本次作为 CGR 背景使用，不应描述为已完成全基因组预测。公开记录不包含票据、访问令牌或 Cookie。

原始下载文件与机器可读报告另存于忽略的 `.codex-runtime/prediction-live/20260907-public-use/`。本地免验证入口此前的阻塞及检查见 [本地测试验收记录](prediction-local-test-acceptance-2026-09-07.md)。
