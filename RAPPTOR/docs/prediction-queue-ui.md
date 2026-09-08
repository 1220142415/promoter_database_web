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
| Waiting in total | Docker job `queue.waiting` | Waiting jobs in this queue, including this task |
| Service availability | `/v1/status` `workers[mode]` | Readiness of the selected processing queue |
| Estimated wait to start | Optional job `queue.estimated_wait_seconds` | Approximate seconds until this task starts, not time until results |

The current Docker contract does not supply an ETA. Until it does, the UI
shows a dash. The compact card keeps Running, Queued ahead, and Est. wait in
three columns, including narrow screens, without explanatory paragraphs.
A zero queued-ahead count
means first in the waiting list, not immediate execution. Missing counters are
shown as unknown, and task progress is not displayed as 0% while queued.

For future Docker ETA support, add nullable `estimated_wait_seconds` to
`JobQueueStatus` and calculate it server-side from recent comparable task
durations, active-task remaining work, queued work ahead, and actual worker
concurrency. Return null when workers are unavailable or samples are
insufficient. A count multiplied by a fixed duration is not reliable across
different genome sizes, strides, strands, and input-preparation times.
No new secret is required. The frontend already handles this optional field.

`Busy` indicates running work or waiting work ahead; it is not a CPU usage
measurement. Short-sequence and genome-scan counts are not added together.
If Docker maps both modes onto the same queue, its queue counts reflect that
shared capacity. These snapshots can change while a job is being dispatched.
