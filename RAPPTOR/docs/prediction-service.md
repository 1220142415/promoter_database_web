# RAPPTOR promoter prediction service

Status: proposed MVP design (2026-08-25)

This document records the first implementation boundary for running the
RAPPTOR promoter prediction model as a queued Docker service. It does not
include model training or a public, anonymous model API.

## Goals

- Run the existing prediction model reproducibly on CPU or GPU.
- Let the RAPPTOR website submit work without exposing a reusable service
  credential to the browser.
- Limit abusive requests without requiring user accounts.
- Queue long-running predictions and expose their status and result.
- Keep enough permanent metadata to audit usage and reproduce a result.

The MVP will not add accounts, billing, multiple queue priorities, Celery,
Kubernetes, or automatic GPU scaling. Add those only after measured demand.

## System boundary and flow

```text
Browser
  1. POST /api/prediction-tickets + Turnstile token
     -> Cloudflare Worker applies IP/quota limits
     <- one-time ticket (60-120 second lifetime)

  2. POST /v1/jobs + ticket + prediction input
     -> Docker API asks Cloudflare Worker to consume the ticket
     -> Docker API creates job metadata and enqueues the job in Redis
     <- job_id and queued status

  3. GET /v1/jobs/{job_id}
     <- queued | running | succeeded | failed, progress, result URL

Redis queue
  -> one or more model workers
  -> prediction output to R2
  -> permanent job status/result metadata to D1 through an authenticated
     internal Cloudflare Worker endpoint
```

The prediction API is internet reachable only through HTTPS and a reverse
proxy. It must not accept a job until Cloudflare confirms that its ticket was
consumed. Calls between the model service and Cloudflare use a server-only
secret; that secret is never sent to the browser.

## One-time ticket

Cloudflare generates 32 cryptographically random bytes and returns their
URL-safe encoding. D1 stores only a SHA-256 hash of the ticket, never its
plaintext value.

Each ticket contains or references these constraints:

```text
ticket_hash
ip_hash
scope                 prediction submission
model_version
max_bases
issued_at
expires_at
used_at                null until consumed
```

The consume operation must be one atomic conditional update:

```sql
UPDATE prediction_tickets
SET used_at = CURRENT_TIMESTAMP
WHERE ticket_hash = ?
  AND used_at IS NULL
  AND expires_at > CURRENT_TIMESTAMP;
```

Exactly one changed row means the ticket is valid. Zero changed rows means it
is unknown, expired, or already used. Validation also checks the requested
model and input size against the ticket constraints.

A signed JWT alone is insufficient because it can be replayed until expiry.
D1 atomic consumption is adequate for the MVP; do not add a separate ticket
service unless D1 becomes a measured bottleneck.

## Limits without login

Apply limits when issuing a ticket, not only when submitting a job. Otherwise
a client can request unlimited valid tickets.

Initial limits should be configuration, with conservative deployment values:

- tickets issued per IP per minute;
- submitted bases per IP per day;
- queued jobs per IP;
- running jobs per IP;
- total global queue length;
- maximum bases and upload bytes per job.

Use Cloudflare Turnstile on ticket requests and store only a salted IP hash in
D1. Return `Retry-After` for temporary limits. IP limits deter casual abuse,
but are not identity or a billing boundary; API keys or accounts are required
if reliable per-user quotas become necessary.

## Queue and process model

Use Redis with RQ for the MVP:

```text
container/image
├── API process       validates input, consumes ticket, creates and enqueues job
└── worker process    loads model, predicts, writes output, reports final state
```

The API and worker use the same Docker image but run different commands. Start
one prediction worker per GPU. CPU deployments may increase worker count only
after memory and throughput testing. A job state follows:

```text
queued -> running -> succeeded
                  \-> failed
```

Workers must make terminal updates idempotent so retrying a callback does not
duplicate a result. Set job timeouts and retain failed-job diagnostics for a
short, configured period. Cancellation and priority queues are deferred.

## Storage ownership

| Store | Owns | Must not own |
| --- | --- | --- |
| D1 | ticket hashes and consumption, quota counters, permanent job metadata, model version, result location | FASTA, GFF3, BigWig, model artifacts |
| Redis | queue, locks, transient progress and short-lived failure details | permanent audit history or large files |
| R2 | uploaded input and generated FASTA/GFF3/BigWig/JSON results | ticket validation or queue state |

R2 objects should use unguessable job IDs and private buckets. The website
returns short-lived signed download URLs or streams an authorized object.
Retention rules must be declared before accepting production data.

## API contract

### Website/Cloudflare

```http
POST /api/prediction-tickets
Content-Type: application/json

{ "turnstileToken": "...", "modelVersion": "...", "bases": 12345 }
```

Success returns the one-time ticket, expiry, and accepted limits. This route
performs Turnstile verification and quota checks.

```http
POST /api/internal/prediction-tickets/consume
Authorization: Bearer <service-secret>
Content-Type: application/json

{ "ticket": "...", "modelVersion": "...", "bases": 12345 }
```

This route is server-to-server only. It atomically consumes the ticket and
returns a minimal allow/deny response.

The model service reports job creation and terminal state through another
authenticated internal route. That route owns D1 job metadata writes; the
external Docker host does not receive direct D1 credentials.

### Prediction service

```http
POST /v1/jobs
Authorization: Ticket <one-time-ticket>
```

The request contains a supported sequence input or an R2 upload reference.
Success returns:

```json
{ "job_id": "...", "status": "queued" }
```

```http
GET /v1/jobs/{job_id}
```

The response contains the state, timestamps, model version, safe progress
information, and a result reference after success. Access to a job requires an
unguessable job access token; knowing a sequential ID must never expose data.

Common failures:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | Unsupported or malformed sequence/input |
| 401 | `INVALID_TICKET` | Ticket unknown, expired, reused, or wrong scope |
| 413 | `INPUT_TOO_LARGE` | Ticket or service input limit exceeded |
| 429 | `RATE_LIMITED` | Per-IP quota or queue limit reached |
| 503 | `QUEUE_UNAVAILABLE` | Redis/model capacity temporarily unavailable |

## Deployment and security requirements

- Pin the Python base image and model dependency versions.
- Run the container as a non-root user with a read-only model mount where
  practical.
- Expose a lightweight `/healthz`; keep model readiness separate if loading is
  slow.
- Terminate TLS at the reverse proxy and restrict internal callback routes
  with a rotated service secret.
- Validate FASTA content, names, encoding, byte size, and total bases before
  enqueueing; never execute user-provided filenames or command fragments.
- Do not log raw sequence data, tickets, service secrets, or full IP addresses.
- Record model version, container image digest, input checksum, timestamps,
  and output checksum for reproducibility.
- Monitor queue depth, wait time, run time, success/failure rate, GPU memory,
  disk usage, Redis availability, and ticket rejection reasons.

## Delivery plan and estimate

Assumptions: a stable pure-Python inference entry point, weights, and a known
test sample already exist; CPU/GPU target is selected; retraining is excluded.
One person working full-time is estimated as follows:

| Phase | Deliverable | Estimate |
| --- | --- | ---: |
| 0 | Wrap inference and benchmark memory/runtime | 2-4 person-days |
| 1 | FastAPI, Docker image, health/readiness checks | 2-3 person-days |
| 2 | D1 migration, one-time tickets, Turnstile and limits | 3-5 person-days |
| 3 | Redis/RQ queue, worker lifecycle and job status | 3-5 person-days |
| 4 | R2 input/output and result format | 3-5 person-days |
| 5 | RAPPTOR submission/status/result UI and API integration | 3-5 person-days |
| 6 | Deployment, monitoring, load and failure testing | 3-5 person-days |
| **MVP total** | End-to-end production candidate | **16-27 person-days** |

The phases partially overlap for two developers, but GPU debugging and final
integration remain sequential. A practical calendar estimate is 4-6 weeks for
one developer or 3-4 weeks for two developers, including review and fixes.

Add approximately 5-10 person-days if inference is not yet stable, CUDA needs
target-specific adaptation, or GFF3/BigWig conversion still has to be built.
Production operations such as high availability, autoscaling, user accounts,
billing, and multi-tenant isolation are separate work.

## Acceptance criteria for the MVP

- A valid ticket can create exactly one job; replay and expired tickets fail.
- Ticket issuance and job submission limits return deterministic errors.
- Concurrent submissions remain queued and do not over-commit the GPU.
- A known test sequence produces the expected versioned result after restart.
- Redis/API/model failure paths end in a visible retryable or terminal state.
- Input and output are private, expire according to policy, and are not leaked
  through logs or predictable identifiers.
