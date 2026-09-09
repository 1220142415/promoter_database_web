# Real sequence and online inference acceptance

`/predict` queues real tasks through the existing authenticated ticket and quota routes. `/predict/preview` is an explicit development-only entry; its scores are illustrative. A failed service request or missing reference never creates substitute scores or bases. Email setup is a separate deployment step; see [prediction-email-auth.md](prediction-email-auth.md).

Model readiness alone does not enable submission. Production checks sign-in, human verification and ticket configuration. The explicitly configured development mode instead checks the private remote test-ticket issuer. Both explain missing setup beside the disabled queue button and provide **Check availability again** without clearing input. See [local real prediction setup](prediction-local-test.md) for the loopback-only development mode, dedicated Cloudflare Secret and deployment procedure.

## Fixed public reference

The checked-in source of truth is `src/features/prediction/examples/ecoli-k12.json`: E. coli K-12 MG1655, assembly `GCF_000005845.1`, chromosome `NC_000913.2`, **4,639,675 bp**. The 100 bp example is the positive-strand interval **100001–100100**, using 1-based inclusive coordinates. It is a genomic fragment, with no assumed promoter activity or experimental TSS support.

The 100 bp example selects this `.1` accession in the catalog area. It submits `reference_accession` for cached CGR use without downloading the complete genome into the browser. The whole-genome scan example also uses this pinned `.1` reference. Its original FASTA SHA-256 is `2a8e2f78bc145fa82fa325acf7d34dc944612795cee74f793045dc64d782176c`.

For 100 bp input, switch to **Upload complete genome FASTA** to reveal the separate **Load NCBI .2 FASTA example** action. Its source of truth is `src/features/prediction/examples/ecoli-k12-upload.json`: `GCF_000005845.2`, chromosome `NC_000913.3`, 4,641,652 bp. This explicit action downloads the NCBI example through `/api/prediction-reference/GCF_000005845.2`, verifies it, and fills the file-background state. Submission sends the complete `fasta` with the short `sequence`, never `.2` as `reference_accession`. It is not a catalog or CGR-cache entry. The sample interval has the same 100 bp in both references, but the whole genomes and checksums differ. Catalog/NCBI selection and FASTA upload are mutually exclusive in the form.

The reference endpoint allows only the two configured accessions. Both the loader and browser validate the original FASTA checksum, contig identity, full sequence length/checksum, and coordinate-derived sample; gzip input also has a source-byte checksum and decompressed-size limit. Concurrent downloads are deduplicated separately per accession. Files are cached under ignored `.data/prediction-examples/` only in development. A failed example download permits retry or manual upload; switching back to the catalog invalidates pending file-selection updates.

## Explicit live command

Use Node 22.18+ (native TypeScript stripping), from the RAPPTOR directory. Ordinary Vitest/CI never submits live work. In PowerShell:

```powershell
$env:RAPPTOR_PREDICTION_SERVICE_URL = 'https://4090server.duolalab.qzz.io'
$env:RAPPTOR_PREDICTION_MODEL_VERSION = 'candidate-github-93cf'
$env:RAPPTOR_LIVE_RUN_DIR = '.codex-runtime/prediction-live/20260907-real-sequences'
npm run test:prediction:live
```

Start the configured app with `npm run prediction:local:dev` first. The runner automatically requests a fresh, genuine one-time ticket from its loopback `/api/prediction-tickets` immediately before each new task and submits through `/api/predictions/jobs`. No manually copied tickets are needed. The dedicated development secret remains in the local server; the runner never reads it. Resume does not request another ticket for an existing task. No shared model service secret or forged ticket is supported.

The candidate request bills the 100 bp scoring target; its reference genome is context, not an additional scan input. The genome request bills 4,641,652 bases. Tickets must allow the selected candidate model and corresponding input size. The command first verifies readiness, the selected model and the real reference; an unavailable or unauthorized ticket issuer produces `blocked_credentials` without submitting a task. The model service retains its normal ticket validation. Production email authentication, user quota and Turnstile checks remain intact; local tests use the protected issuer's independent quota and register no email notifications.

The runner submits tasks sequentially:

1. `predict`: the real 100 bp sample, complete-genome CGR, both strands; exactly two scores.
2. `genome_scan`: the entire reference as the request's sole FASTA input, stride 1, both strands; exactly **2 × (4,641,652 − 100 + 1) = 9,283,106 windows**. It never submits a separate `genome_context`. Request BigWig and Parquet to retain every window without a huge unfiltered GFF3 export.

The existing service lacks `score_cutoff`. Requests omit it; the normal scan page disables export filtering. Real 100 bp output shows scores without threshold classification. The model is fixed to `candidate-github-93cf`, checkpoint `93cfcbaf74e3a693dfd12406d11ad79fef0933b90913db83c230a3f3a99582ad`, and remains a candidate model. No deployment or model change is made.

## Records, recovery and browser checks

The run directory must remain within ignored `.codex-runtime/prediction-live/`. `report.json` contains no access token or ticket: it records reference verification, task IDs, model identity, parameters, score/window checks and artifact sizes/SHA-256. `access.private.json` contains protected task access and local result URLs. Keep it private. Set `RAPPTOR_LIVE_LOCAL_URL` if the local app uses a port other than 3000.

Resume by running the same command with the same run directory. Already-created tasks retain their IDs. A network or server failure during submission is marked uncertain; inspect the service outcome before clearing that marker to prevent duplicate full-genome scans. Definite validation/authentication rejections allow retry with valid credentials. The polling timeout defaults to two hours and can be set with `RAPPTOR_LIVE_TIMEOUT_MS`; timing out preserves task access.

Run the local app with the same `RAPPTOR_PREDICTION_SERVICE_URL` and model version, then privately open the returned `/predict/task/[jobId]` link. The link exchanges its job token for the existing protected artifact session. Browser history/session restores the same task on refresh. The short result reads the actual `scores.json`; the genome browser reads task FASTA, FAI and BigWig. Missing/expired artifacts and failed jobs display errors.

The runner validates model/strand/input/window identity, both short scores, artifact hashes, the returned genome and FAI, and HTTP Range responses for FASTA, FAI and both BigWigs. Browser acceptance is recorded separately: view both real results, zoom the genome to bases, pan/zoom out, refresh to restore the task, inspect Range traffic and console. A runner pass alone does not certify browser acceptance or model accuracy. Without valid tickets there are no real results to verify; do not use the development preview as a substitute.
