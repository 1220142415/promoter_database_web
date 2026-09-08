# Prediction queue display

Task pages poll the same-origin job status endpoint every 30 seconds.
While a job is queued, the Worker also reads Docker `/v1/status` with a
3-second timeout and includes only the job's processing-queue running count
and worker readiness in that response. There is no additional browser poll.
Load lookup failure leaves the authenticated job response usable. No public
cache stores job tokens or private task responses.

Displayed fields:

| Field | Source | Meaning |
| --- | --- | --- |
| Queued ahead of you | Docker job `queue.ahead` | Waiting jobs before this task; excludes running jobs |
| Running now | `/v1/status` `workload.running[mode].jobs` | Running jobs in the selected processing queue |
| Service availability | `/v1/status` `workers[mode]` | Readiness of the selected processing queue |
| Estimated wait to start | Optional job `queue.estimated_wait_seconds` | Approximate seconds until this task starts, not time until results |

Docker now supplies nullable `queue.estimated_wait_seconds` (commit `7778ec2`).
The Worker preserves it while enriching the same response with server load.
The UI shows an approximate duration, or a dash for null/invalid values.
The compact card keeps Running, Queued ahead, and Est. wait in
three columns, including narrow screens, without explanatory paragraphs.
A zero queued-ahead count
means first in the waiting list, not immediate execution. Missing counters are
shown as unknown, and task progress is not displayed as 0% while queued.

ETA is calculated by Docker from recent throughput and comparable task
durations, queued work and worker concurrency. Null means insufficient data;
the frontend does not invent a duration or issue another browser request.
No new secret is required.

## Watchdog failure contract

Docker commit `81c08db` replaces the fixed wall-clock timeout with a progress
watchdog. Failed responses wrap the previous snapshot in
`progress.last_valid_progress`. The task page uses that snapshot for stage,
overall percentage, reference, strand, and processed-window counters while
keeping the task failed and downloads unavailable.

`error.code` distinguishes `JOB_PROGRESS_STALLED`,
`JOB_PROCESS_HEARTBEAT_LOST`, and ordinary `JOB_FAILED`. Missing error messages
fall back to a stopped message, never an ongoing-scanning message. Legacy
failed 100% values are treated as unknown, with no full progressbar or
result-ready marker. Status polling stops on terminal states as before.

The accompanying upstream quota changes affect explicitly authenticated local
tests only; public daily limits remain 5 genome scans and 12,000,000 bases.

`Busy` indicates running work or waiting work ahead; it is not a CPU usage
measurement. Short-sequence and genome-scan counts are not added together.
If Docker maps both modes onto the same queue, its queue counts reflect that
shared capacity. These snapshots can change while a job is being dispatched.
