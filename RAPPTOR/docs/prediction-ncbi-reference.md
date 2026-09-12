# Prediction: browser-managed NCBI/Hugging Face references

## Scope and user experience

The existing genome-context search checks the site catalog first. If it returns no rows and the user entered a versioned assembly ID (`GCF_` or `GCA_`, nine digits, then a version), the same search checks NCBI Assembly. Species-name searches remain local. There is no additional NCBI search button and no search on every keystroke.

External results and the selected reference are marked `NCBI · External reference`. Users explicitly select the result before submitting. Missing versions are never silently replaced by a newer version. Search failures preserve the input and do not start a prediction or download a genome.

This fallback supplies the complete-genome **CGR context** for either a single
100 bp prediction or a sequence scan. In scan mode, the NCBI assembly is not
silently substituted as the target: the browser still supplies the FASTA
region or assembly to evaluate, while the selected accession supplies only its
complete-reference CGR. Preview mode does not offer this fallback. The browser
downloads, decompresses, and validates the selected FASTA before it requests a
ticketed prediction; the Worker receives only the resulting sequence payload.

## Data flow

```text
Browser: existing genome search
  → Worker /api/genomes → local catalog
  → if empty + versioned ID: browser requests NCBI Datasets metadata
      → browser derives the exact NCBI FTP genomic FASTA URL
      → browser downloads/decompresses and validates the FASTA

Browser: verify, obtain ticket, submit 100 bp + genome_context
  → Worker /api/predictions/jobs
      → Docker /v1/jobs: mode=predict + sequence + genome_context
          → existing job ID, token, status and artifact flow
```

Browser request to `/api/predictions/jobs`:

```json
{
  "mode": "predict",
  "sequence": "<exactly 100 A/C/G/T bases>",
  "ncbi_accession": "GCF_000005845.2",
  "complete_genome": true,
  "reverse_complementary": true
}
```

Use the normal `Authorization: Ticket ...` header. For `predict`, ticket `bases`
is **100**; for `genome_scan`, it is the parsed target FASTA base count.
Reference byte limits are checked separately. The Worker translates
`ncbi_accession` to the existing Docker `reference_accession` only after cache
preparation. Ordinary catalog `reference_accession` requests use the same
preparation flow on a miss. No URLs, file paths, checksums or import IDs are
accepted from the browser. A request with more than one reference source is
rejected before downloading.

For `genome_scan`, the same protected preparation path accepts the selected
accession, but the ticket is bound to `genome_scan`, the exact accession and
the parsed bases in the target FASTA. Docker receives the target FASTA plus
`reference_accession`; it loads the cached CGR and never treats the downloaded
reference as scan input. A scan may instead send `genome_context`, or omit both
reference fields to derive the CGR from the target FASTA. Conflicting reference
sources are rejected.

## Storage, limits and failure behavior

- FASTA is held in temporary memory for the Worker request, not persisted to D1, R2 or the browser. The runtime reclaims that memory; there is no persistent Worker filesystem cache.
- Only small lookup metadata is cached: up to 128 entries per isolate; positive results for five minutes and misses for one minute. This is best-effort, not a global cache or global NCBI rate limiter.
- A ready Docker cache causes no FASTA download. CGR PNG and manifest persist in Docker's existing data volume, separated by exact accession and CGR version. Docker deletes temporary imported FASTA after processing. PNG imports remain supported for trusted offline synchronization.
- Preparation requires an unused, matching-model ticket for the exact task kind with at least the submitted target bases and more than 45 seconds remaining. D1 claims at most one preparation per ticket and records `reference_accession` without setting `used_at`; Docker still performs the final consume operation. Consumption rejects a different task kind, reference, or omission of a bound reference.
- No automatic retry of downloads. A failed claim/download preserves browser input. To submit again, perform verification again and obtain a new ticket. The existing per-minute ticket limit still applies.
- Metadata calls have a 10-second deadline; the entire preparation phase (cache query, download, import, polling) has a 40-second deadline and follows request cancellation. Polling is once every 3 seconds only during preparation. A still-running import returns `REFERENCE_PREPARING` with preserved input; it is not canceled or automatically resubmitted. A later submission rechecks the cache.
- Compressed and decompressed data are each capped at `min(RAPPTOR_MAX_REQUEST_BYTES, 12 MiB)`. The prediction JSON remains small because it carries only the accession and target sequence.
- Only the exact NCBI assembly directory on `https://ftp.ncbi.nlm.nih.gov/genomes/all/` is accepted. Redirects are rejected. The gzip checksum is checked against NCBI's official **MD5**, not mislabeled as SHA-256. Docker retains final FASTA alphabet/record validation.
- Hugging Face downloads use server-resolved catalog sources only. Redirects are bounded and confined to HTTPS Hugging Face / hf.co hosts; service credentials are never attached to downloads. Source file SHA-256 and uncompressed FASTA SHA-256 are distinct and must not be interchanged.
- No new API key or secret is required. Worker `RAPPTOR_PREDICTION_SERVICE_SECRET` equals Docker `RAPPTOR_TICKET_SERVICE_SECRET`; the secret stays server-side. NCBI upstream throttling/outages are reported as unavailable, not as a successful empty search.

## Deployment prerequisites and acceptance

1. Apply D1 migrations `0015_prediction_reference_download.sql` and `0016_prediction_reference_binding.sql` **before** deploying these routes. They add nullable preparation time and exact reference binding to `prediction_tickets`. Keep existing ticket secret/model/TTL settings. Missing database/schema fails closed for this path.
2. Deploy Docker's FASTA-capable cache API and cache worker first, preserving data/Redis volumes and model mounts. Then deploy the Worker/frontend together. Docker and Worker both accept exact GCF/GCA versions; Docker does not download references.
3. In the deployed UI, search a missing catalog accession with a known NCBI version. Check the source label, explicit selection, 100 bp ticket and small browser POST; there must be no full genome response to the browser on this new path.
4. Validate a real NCBI download from Cloudflare and record CPU time, peak memory, wall time and error outcome. Download waiting is not CPU time, but checksum/decompression/JSON serialization consume CPU; mock tests cannot prove compliance with the free plan's CPU limit. Do not call this production-accepted until measured.
5. Confirm duplicate/expired tickets do not download, NCBI failures preserve input, and ordinary catalog/upload/scan submissions still work.

Automated tests cover official response shapes, safe URL derivation/redirects, MD5/SHA-256/gzip handling, size caps, ticket binding, cache hit/miss/import polling and frontend transport. Mock tests alone do not establish real NCBI connectivity or Cloudflare CPU acceptance; see the dated integration report for actual deployment and live acceptance evidence.
