import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REAL_PREDICTION_REFERENCE as reference, validateReferenceExample } from '../../src/features/prediction/reference-example.ts';
import { parseFocusedScores } from '../../src/features/prediction/focused-scores.ts';

const MODEL = 'candidate-github-93cf';
const CHECKPOINT = '93cfcbaf74e3a693dfd12406d11ad79fef0933b90913db83c230a3f3a99582ad';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export async function fetchLiveRead(url, options = {}, request = fetch, wait = pause) {
  if (options.method && options.method !== 'GET') throw new Error('Only read requests may be retried.');
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await request(url, { signal: AbortSignal.timeout(120_000), ...options });
      if (![502, 503, 504].includes(response.status) || attempt === 3) return response;
      await response.body?.cancel();
    } catch (cause) {
      if (attempt === 3 || options.signal?.aborted) throw cause;
    }
    await wait(1000 * (attempt + 1));
  }
}

export function validateSummary(summary, kind) {
  if (summary.model?.model_version !== MODEL || summary.model?.checkpoint_sha256 !== CHECKPOINT) throw new Error('The service returned an unexpected model/checkpoint identity.');
  const windows = kind === 'candidate' ? 2 : 2 * (reference.length - 99);
  if (summary.window_count !== windows) throw new Error(`Unexpected scored-window count for ${kind}.`);
  if (summary.reverse_complementary !== true || summary.mode !== (kind === 'candidate' ? 'predict' : 'genome_scan')) throw new Error('Unexpected task mode or strand parameters.');
  if (kind === 'candidate') {
    if (summary.sequence_bases !== 100 || summary.genome_context_bases !== reference.length) throw new Error('Candidate/CGR input lengths do not match the reference.');
  } else if (summary.total_bases !== reference.length || summary.contig_count !== 1 || summary.stride !== 1) throw new Error('Genome scan input or stride does not match the reference.');
}

async function responseJson(response, operation) {
  if (!response.ok) {
    const ticket = response.status === 401 || response.status === 403;
    throw new Error(ticket ? `${operation} requires valid authorization. Check the local test configuration and remote development key; existing task tokens may have expired.` : `${operation} returned HTTP ${response.status}.`);
  }
  return response.json();
}

export async function acquireLiveTicket(localBase, input, request = fetch) {
  const origin = new URL(localBase);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    || origin.href !== `${origin.origin}/`) throw new Error('The live test app URL must be a loopback HTTP origin.');
  const response = await request(`${origin.origin}/api/prediction-tickets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin.origin },
    body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Local test ticket acquisition returned HTTP ${response.status}. Check the local page for the configuration or quota error. No task was submitted.`);
  const ticket = await response.json();
  if (typeof ticket.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket.ticket)
    || ticket.modelVersion !== input.modelVersion || ticket.maxBases !== input.bases || !(Date.parse(ticket.expiresAt) > Date.now())) {
    throw new Error('Local test ticket acquisition returned an invalid or expired ticket. No task was submitted.');
  }
  return ticket;
}

async function main() {
  const base = (process.env.RAPPTOR_PREDICTION_SERVICE_URL || 'https://4090server.duolalab.qzz.io').replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('Live service must use HTTPS.');
  const localBase = process.env.RAPPTOR_LIVE_LOCAL_URL || 'http://127.0.0.1:3000';
  const runDir = resolve(process.env.RAPPTOR_LIVE_RUN_DIR || `.codex-runtime/prediction-live/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const withinRuntime = relative(resolve('.codex-runtime/prediction-live'), runDir);
  if (withinRuntime.startsWith('..') || isAbsolute(withinRuntime)) throw new Error('Run records must stay inside the ignored .codex-runtime/prediction-live directory.');
  await mkdir(runDir, { recursive: true });
  const publicFile = join(runDir, 'report.json');
  const privateFile = join(runDir, 'access.private.json');
  let access = {};
  try { access = JSON.parse(await readFile(privateFile, 'utf8')); } catch (cause) {
    if (cause.code !== 'ENOENT') throw new Error('Private access records could not be read. Inspect the local file without publishing its contents.');
  }
  const report = { status: 'running', browserVerification: 'not_run', service: base, modelVersion: MODEL, modelStatus: 'candidate_not_production', reference, startedAt: new Date().toISOString(), jobs: [] };
  const save = () => writeFile(publicFile, `${JSON.stringify(report, null, 2)}\n`);
  const saveAccess = async () => {
    await writeFile(`${privateFile}.partial`, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
    await rename(`${privateFile}.partial`, privateFile);
  };
  const request = (path, options = {}) => fetchLiveRead(`${base}${path}`, options);
  await save();
  console.log(`Live verification report: ${publicFile}`);
  try {
    const ready = await responseJson(await request('/readyz'), 'Readiness check');
    if (ready.status !== 'ready') throw new Error('Prediction worker is not ready.');
    const model = await responseJson(await request('/v1/models/current'), 'Model lookup');
    if (model.model_version !== MODEL) throw new Error('Configured live model does not match the selected candidate.');
    report.serviceCapabilities = model;
    const cacheDir = resolve('.data/prediction-examples');
    const fastaFile = join(cacheDir, reference.fileName);
    let fasta;
    try { fasta = await readFile(fastaFile, 'utf8'); } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      console.log('Downloading the pinned Hugging Face reference.');
      const upstream = await fetch(reference.sourceUrl, { signal: AbortSignal.timeout(180_000) });
      if (!upstream.ok) throw new Error(`Hugging Face reference returned HTTP ${upstream.status}.`);
      if (!upstream.body) throw new Error('Hugging Face reference has no response body.');
      const chunks = [];
      let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('Reference exceeds the size limit.');
        chunks.push(chunk);
      }
      const packed = Buffer.concat(chunks);
      if (packed.length > 8 * 1024 * 1024 || hash(packed) !== reference.sourceSha256) throw new Error('Reference source checksum/size mismatch.');
      fasta = packed.toString('utf8');
      await validateReferenceExample(fasta);
      await mkdir(cacheDir, { recursive: true });
      await writeFile(fastaFile, fasta);
    }
    const validated = await validateReferenceExample(fasta);
    report.referenceVerification = { status: 'passed', fastaSha256: hash(fasta), sequenceSha256: hash(validated.sequence), sampleSha256: hash(validated.sample), length: validated.length };
    console.log(`Reference verified: ${reference.sequenceId}, ${validated.length} bp.`);

    for (const kind of ['candidate', 'genome']) {
      const submission = kind === 'candidate'
        ? { mode: 'predict', complete_genome: true, sequence: validated.sample, genome_context: validated.sequence, reverse_complementary: true }
        : { mode: 'genome_scan', complete_genome: true, fasta, stride: 1, reverse_complementary: true, output_formats: ['bigwig', 'parquet'] };
      const jobReport = { kind, status: 'pending', inputSha256: kind === 'candidate' ? reference.sample.sha256 : reference.fastaSha256, contextSha256: reference.sequenceSha256, parameters: { stride: 1, strands: 'both', scoreCutoff: null }, artifacts: [] };
      report.jobs.push(jobReport);
      if (access[kind]?.submissionUncertain) throw new Error(`An earlier ${kind} submission has an uncertain outcome; inspect it before submitting again.`);
      if (!access[kind]?.jobId) {
        let issued;
        try {
          issued = await acquireLiveTicket(localBase, { mode: submission.mode, modelVersion: MODEL, bases: kind === 'candidate' ? reference.length + 100 : reference.length });
        } catch (cause) {
          jobReport.status = 'blocked_credentials';
          throw cause;
        }
        jobReport.ticket = { expiresAt: issued.expiresAt, modelVersion: issued.modelVersion, maxBases: issued.maxBases };
        access[kind] = { submissionUncertain: true };
        await saveAccess();
        const headers = { 'Content-Type': 'application/json', Origin: new URL(localBase).origin, Authorization: `Ticket ${issued.ticket}` };
        const response = await fetch(`${new URL(localBase).origin}/api/predictions/jobs`, { method: 'POST', headers, body: JSON.stringify(submission), redirect: 'error', signal: AbortSignal.timeout(120_000) });
        // Network/5xx outcomes may have enqueued work. Preserve uncertainty to avoid duplicate scans.
        if ([400, 401, 403, 413, 422, 429].includes(response.status)) { delete access[kind]; await saveAccess(); }
        const created = await responseJson(response, `${kind} submission`);
        if (!/^[0-9a-f]{32}$/.test(created.job_id) || typeof created.access_token !== 'string') throw new Error('Service returned an invalid job identity.');
        access[kind] = { jobId: created.job_id, token: created.access_token, mode: submission.mode, refName: kind === 'genome' ? reference.sequenceId : '', label: kind === 'genome' ? reference.organism : `${reference.sequenceId}:100001-100100 (+)`, bases: kind === 'genome' ? reference.length : 100 };
        await saveAccess();
      }
      const identity = access[kind];
      jobReport.jobId = identity.jobId;
      const auth = { 'X-Job-Token': identity.token };
      const deadline = Date.now() + Number(process.env.RAPPTOR_LIVE_TIMEOUT_MS || 7_200_000);
      let state;
      let lastProgress = '';
      do {
        state = await responseJson(await request(`/v1/jobs/${identity.jobId}`, { headers: auth }), 'Job status');
        jobReport.status = state.status;
        jobReport.progress = state.progress;
        const progress = `${state.status} ${state.progress?.stage || ''} ${state.progress?.percent ?? ''}`;
        if (progress !== lastProgress) { console.log(`${kind}: ${progress}`); lastProgress = progress; await save(); }
        if (state.status === 'failed' || state.status === 'unknown') throw new Error(`${kind} job ended with status ${state.status}; inspect its protected result.`);
        if (state.status === 'succeeded') break;
        if (Date.now() > deadline) throw new Error('Live verification timed out; resume the same run directory to keep the existing jobs.');
        await pause(5000);
      } while (true);
      const artifacts = state.result?.artifacts;
      if (!Array.isArray(artifacts)) throw new Error('Completed job has no artifact manifest.');
      const required = kind === 'candidate' ? ['scores.json', 'summary.json'] : ['summary.json', 'input.fasta', 'input.fasta.fai', 'scores.plus.bw', 'scores.minus.bw', 'scores.parquet'];
      for (const filename of required) if (!artifacts.some((item) => item.filename === filename)) throw new Error(`Required artifact missing: ${filename}.`);
      const artifactDir = join(runDir, kind);
      await mkdir(artifactDir, { recursive: true });
      for (const artifact of artifacts) {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(artifact.filename) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes < 0) throw new Error('Invalid artifact manifest.');
        const path = join(artifactDir, artifact.filename);
        const response = await request(`/v1/jobs/${identity.jobId}/artifacts/${artifact.filename}`, { headers: auth, signal: AbortSignal.timeout(900_000) });
        if (!response.ok || !response.body) throw new Error(`Artifact ${artifact.filename} returned HTTP ${response.status}.`);
        const digest = createHash('sha256');
        let bytes = 0;
        await pipeline(Readable.fromWeb(response.body), new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length;
            if (bytes > artifact.size_bytes) { done(new Error(`Artifact size exceeded: ${artifact.filename}.`)); return; }
            digest.update(chunk); done(null, chunk);
          },
        }), createWriteStream(`${path}.partial`));
        const actualSha256 = digest.digest('hex');
        if (actualSha256 !== artifact.sha256 || bytes !== artifact.size_bytes) throw new Error(`Artifact checksum/size mismatch: ${artifact.filename}.`);
        await rename(`${path}.partial`, path);
        jobReport.artifacts.push({ filename: artifact.filename, bytes, sha256: actualSha256 });
        console.log(`${kind}: verified ${artifact.filename} (${bytes} bytes).`);
      }
      const summary = JSON.parse(await readFile(join(artifactDir, 'summary.json'), 'utf8'));
      jobReport.summary = summary;
      // Keep the returned evidence and continue to the independent genome case
      // if the candidate service fails its strand contract. Never mark it passed.
      try {
        validateSummary(summary, kind);
        if (kind === 'candidate') jobReport.scores = parseFocusedScores(JSON.parse(await readFile(join(artifactDir, 'scores.json'), 'utf8')));
      } catch (cause) {
        jobReport.status = 'acceptance_failed';
        jobReport.error = cause.message;
        identity.url = `${localBase}/predict/task/${identity.jobId}#access=${encodeURIComponent(identity.token)}&ref=${encodeURIComponent(identity.refName)}&mode=${identity.mode}`;
        await saveAccess(); await save();
        console.error(`${kind}: ${cause.message} Continuing with the next independent case.`);
        continue;
      }
      if (kind === 'genome') {
        const returned = await readFile(join(artifactDir, 'input.fasta'), 'utf8');
        const returnedSequence = returned.split(/\r?\n/).filter((line) => !line.startsWith('>')).join('').trim();
        if (hash(returnedSequence) !== reference.sequenceSha256 || !returned.startsWith(`>${reference.sequenceId}`)) throw new Error('Returned reference sequence differs from the submitted genome.');
        const fai = (await readFile(join(artifactDir, 'input.fasta.fai'), 'utf8')).trim().split(/\r?\n/);
        if (fai.length !== 1 || fai[0].split('\t')[0] !== reference.sequenceId || Number(fai[0].split('\t')[1]) !== reference.length) throw new Error('Returned reference index has an unexpected contig/length.');
        for (const filename of ['input.fasta', 'input.fasta.fai', 'scores.plus.bw', 'scores.minus.bw']) {
          const range = await request(`/v1/jobs/${identity.jobId}/artifacts/${filename}`, { headers: { ...auth, Range: 'bytes=0-15' } });
          if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 16) throw new Error(`Range verification failed: ${filename}.`);
        }
      }
      jobReport.status = 'verified';
      identity.url = `${localBase}/predict/task/${identity.jobId}#access=${encodeURIComponent(identity.token)}&ref=${encodeURIComponent(identity.refName)}&mode=${identity.mode}`;
      await saveAccess(); await save();
    }
    report.status = report.jobs.every((job) => job.status === 'verified') ? 'passed' : 'acceptance_failed';
    report.finishedAt = new Date().toISOString();
    await save();
    if (report.status === 'passed') console.log('Real inference and artifact verification passed. Browser verification is a separate acceptance step.');
    else { console.error('Real inference completed, but at least one acceptance check failed. See the per-job evidence.'); process.exitCode = 1; }
  } catch (cause) {
    report.status = report.jobs.some((job) => job.status === 'blocked_credentials') ? 'blocked_credentials' : 'incomplete';
    report.error = cause.message;
    await save(); throw cause;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((cause) => { console.error(cause.message); process.exitCode = 1; });
}
