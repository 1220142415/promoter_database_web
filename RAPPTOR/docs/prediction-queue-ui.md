# 任务队列与进度显示

任务页读取 `GET /api/predictions/jobs/{jobId}`，使用 `X-Job-Token` 授权。
Docker 在该响应中提供 `queue` 和 `progress`；Worker 转发给网页。

## 轮询与队列字段

全基因组扫描每 30 秒轮询一次。短预测前 20 秒每 2 秒一次，随后至一分钟每
10 秒一次，之后每 30 秒一次。轮询失败时至少等待 10 秒；实现见
`predictionPollDelay`（`src/features/prediction/components/prediction-workbench.tsx`）。

| 显示项 | 响应字段 | 含义 |
| --- | --- | --- |
| 前方任务数 | `queue.ahead` | 当前任务之前等待的任务，不含正在运行的任务 |
| 正在运行 | `queue.running` | 所属处理队列的运行任务数 |
| 服务可用性 | `queue.worker_ready` | 所属队列 worker 是否就绪 |
| 预计等待 | `queue.estimated_wait_seconds` | 到开始执行的估计时间，可为 null |

前方任务为 0 表示队首，不保证立即执行。缺少字段时显示未知；ETA 为 null 时显示
横线，不在前端自行估算。独立服务器概览接口 `/api/predictions/status` 读取 Docker
`/v1/status`，供提交界面展示整体负载。

## 进度与失败

`progress.percent` 是整体进度；`scan_percent` 是扫描窗口进度，100% 后仍可能写文件。
`windows` 和 `total_windows` 表示处理窗口数。字段由 Docker 提供，更新网页不能让旧
worker 自动产生这些字段。

Docker watchdog 监控进度和心跳。失败时可在 `progress.last_valid_progress` 保留上一份
进度；界面展示该快照，同时保持失败状态并禁用下载。
`JOB_PROGRESS_STALLED` 表示进度停止，`JOB_PROCESS_HEARTBEAT_LOST` 表示处理进程失去心跳。
watchdog 的阈值、worker 重启和原始错误字段见 [服务手册](../services/prediction/README.md)。
