# Prediction: NCBI fallback through the Worker

## Scope and user experience

The existing genome-context search checks the site catalog first. If it returns no rows and the user entered a versioned assembly ID (`GCF_` or `GCA_`, nine digits, then a version), the same search checks NCBI Assembly. Species-name searches remain local. There is no additional NCBI search button and no search on every keystroke.

External results and the selected reference are marked `NCBI · External reference`. Users explicitly select the result before submitting. Missing versions are never silently replaced by a newer version. Search failures preserve the input and do not start a prediction or download a genome.

This fallback is for the complete-genome **context of a single 100 bp prediction**. Whole-genome scanning retains its FASTA submission contract; this change does not add NCBI-as-scan-input or alter model behavior. Preview mode does not offer this fallback. Local test tickets cannot authorize this download because they belong to the deployed ticket database.

## Data flow

```text
Browser: existing genome search
  → Worker /api/genomes → local catalog
  → if empty + versioned ID: Worker /api/prediction-references/ncbi
      → NCBI Assembly esearch + esummary (metadata only)
      → Browser receives accession, organismName, source — no FASTA or URL

Browser: verify, obtain ticket, submit 100 bp + ncbi_accession
  → Worker /api/predictions/jobs
      → D1: atomically claim one download on a valid predict ticket
      → NCBI: md5checksums.txt + complete *_genomic.fna.gz
      → bounded download, official MD5 verification, gzip decompression
      → Docker /v1/jobs: standard mode=predict + sequence + fasta
          → Docker consumes the original ticket normally
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

Use the normal `Authorization: Ticket ...` header. Ticket `bases` is **100**, matching Docker's current predict billing; reference byte limits are checked separately. The Worker strips `ncbi_accession` and sends `fasta` to Docker. No URLs, file paths, checksums or new internal metadata fields are accepted from the browser. Supplying another reference source or using this field with `genome_scan` is rejected before downloading.

## Storage, limits and failure behavior

- FASTA is held in temporary memory for the Worker request, not persisted to D1, R2 or the browser. The runtime reclaims that memory; there is no persistent Worker filesystem cache.
- Only small lookup metadata is cached: up to 128 entries per isolate; positive results for five minutes and misses for one minute. This is best-effort, not a global cache or global NCBI rate limiter.
- Each external-reference submission downloads again. Existing Docker upload-path caching is not an accession-cache registration mechanism. This change does **not** populate Docker's catalog CGR cache automatically.
- A download requires an unused, matching-model `predict` ticket with at least 100 bases and more than 45 seconds remaining. A new D1 column claims at most one download per ticket without setting `used_at`; Docker still performs the final consume operation.
- No automatic retry of downloads. A failed claim/download preserves browser input. To submit again, perform verification again and obtain a new ticket. The existing per-minute ticket limit still applies.
- Metadata calls have a 10-second deadline; the submission download phase, including a metadata cache miss, has a 40-second deadline and follows request cancellation.
- Compressed and decompressed data are each capped at `min(RAPPTOR_MAX_REQUEST_BYTES, 12 MiB)`. The final encoded JSON must also fit `RAPPTOR_MAX_REQUEST_BYTES` (default 12 MiB).
- Only the exact NCBI assembly directory on `https://ftp.ncbi.nlm.nih.gov/genomes/all/` is accepted. Redirects are rejected. The gzip checksum is checked against NCBI's official **MD5**, not mislabeled as SHA-256. Docker retains final FASTA alphabet/record validation.
- No new API key or secret is required. NCBI upstream throttling/outages are reported as unavailable, not as a successful empty search.

## Deployment prerequisites and acceptance

1. Apply D1 migration `database/migrations/0015_prediction_reference_download.sql` **before** deploying these routes. It adds nullable `reference_download_started_at` to `prediction_tickets`. Keep existing ticket secret/model/TTL settings. Missing database/schema fails closed for this path.
2. Deploy the Worker/frontend together. Docker requires no change: it receives the already-supported `fasta` field.
3. In the deployed UI, search a missing catalog accession with a known NCBI version. Check the source label, explicit selection, 100 bp ticket and small browser POST; there must be no full genome response to the browser on this new path.
4. Validate a real NCBI download from Cloudflare and record CPU time, peak memory, wall time and error outcome. Download waiting is not CPU time, but checksum/decompression/JSON serialization consume CPU; mock tests cannot prove compliance with the free plan's CPU limit. Do not call this production-accepted until measured.
5. Confirm duplicate/expired tickets do not download, NCBI failures preserve input, and ordinary catalog/upload/scan submissions still work.

At implementation time, direct and proxied NCBI checks from the development machine timed out. Automated tests cover mocked official response shapes, safe URL derivation, MD5/gzip handling, size caps, ticket claims and frontend transport. **Real NCBI connectivity and Cloudflare free-plan CPU acceptance remain unverified. No deployment is included in this change.**
