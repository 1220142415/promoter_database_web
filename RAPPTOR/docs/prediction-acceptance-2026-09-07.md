# Prediction acceptance record — 2026-09-07

This is the earlier real-sequence implementation record. The subsequent local no-login implementation and current authorization decision are recorded in [prediction-local-test-acceptance-2026-09-07.md](prediction-local-test-acceptance-2026-09-07.md).

Overall: **implementation verified locally; real model inference blocked by missing service tickets**. No candidate or genome job was created. No model output was mocked for live acceptance. No service/model deployment was changed.

| Check | Observed outcome |
| --- | --- |
| Public reference | Passed: `GCF_000005845.2`, `NC_000913.3`, 4,641,652 bp, original FASTA SHA-256 `53bb6a51b6e92139ced1e38f74b7938781027c52200922ff03718c2237d23bb4` |
| Sample | Passed: positive-strand bases 100001–100100, 1-based inclusive; exact re-extraction and SHA-256 `1f22c64bb7b35b5f9d9abb71824045d7b803e96c9a8061f01e00a72311d5b772` |
| Service | Readiness and model lookup succeeded at `https://rapptor_server.duolalab.qzz.io`; selected `candidate-github-93cf` |
| Explicit live runner | `npm run test:prediction:live` verified the real inputs, then recorded `blocked_credentials`; no task submission |
| Offline regression suite | 90 files, 564 tests passed; final focused rerun after output-format/runtime adjustments: 2 files, 13 tests passed |
| Static validation | TypeScript, ESLint and isolated Next production build passed; `/predict` is rendered dynamically |
| Actual browser input checks | Passed at local `/predict`: real 100 bp value, complete matching CGR reference, verified accession/length/checksum, full-genome selection, both strands, stride 1, disabled unsupported export filtering; no warning/error console entries observed |
| Real short-sequence scores | Blocked: a valid, unexpired candidate ticket is required |
| Real 9,283,106-window genome scan | Blocked: a separate valid, unexpired genome ticket is required |
| Real task browser, bases/zoom, refresh, FAI/BigWig Range | Not run: no real task artifacts exist yet |
| Legacy preview Playwright specs | Updated for explicit `/predict/preview` and missing-reference errors; not executed in this acceptance run |

Tests/build used the current local installation: Node 25.2.1, Next 15.5.21 and React 19.2.4. The visible dev server used bundled Node 24.19.0. Installed Next/React versions differ from the package/lock targets (15.5.24/19.2.8); these observations do not establish a clean lockfile installation or deployment readiness.

The complete reference and resumable run record remain under ignored `.data/prediction-examples/` and `.codex-runtime/prediction-live/20260907-real-sequences/`. The public `report.json` records input hashes, capabilities and the blocker. Access/ticket records are private and are not included here. See [prediction-live-acceptance.md](prediction-live-acceptance.md) for credential-file format and resume instructions. Tickets expire after 60–120 seconds under the existing issuer, so provide a fresh ticket at each submission or resume between tasks.

The fragment's real genomic provenance does not establish promoter activity, model accuracy or experimental TSS support. The selected model retains its candidate identity throughout acceptance.
