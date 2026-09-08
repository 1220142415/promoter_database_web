import { RESULT_TABLE_FILENAME, SCORE_TRACKS_ZIP_FILENAME, SCORE_TRACK_FILENAMES, resultTableSource, windowCoordinateSystem, type JobArtifact, type JobSummary } from '@/features/prediction/live-result';
import { parseReferenceLengths, resultTableStream } from '@/features/prediction/result-table';
import { scoreTracksZipSize, scoreTracksZipStream } from '@/features/prediction/score-tracks-zip';

export const dynamic = 'force-dynamic';

const JOB_ID = /^[0-9a-f]{32}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;

function serviceUrl(path: string) {
  const base = process.env.RAPPTOR_PREDICTION_SERVICE_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : null;
}

function decodeCookie(value: string | undefined) {
  try { return value ? decodeURIComponent(value) : null; } catch { return null; }
}

async function downloadScoreTracks(request: Request, jobId: string, token: string) {
  const base = serviceUrl(`/v1/jobs/${jobId}`);
  const failure = (status: number, message: string) => Response.json({ error: { code: 'SCORE_TRACKS_UNAVAILABLE', message } }, { status, headers: { 'Cache-Control': 'private, no-store' } });
  if (!base) return failure(503, 'Prediction service is not configured.');
  const responses: Response[] = [];
  let streaming = false;
  const read = (path: string, method = 'GET') => fetch(`${base}${path}`, { method, headers: { 'X-Job-Token': token }, cache: 'no-store', signal: request.signal });
  try {
    const jobResponse = await read('');
    if (!jobResponse.ok) return failure(jobResponse.status, 'Task access is invalid or its results have expired.');
    const job = await jobResponse.json() as { status: string; result?: { artifacts?: JobArtifact[] } };
    if (job.status !== 'succeeded') return failure(409, 'The prediction has not completed.');
    const artifacts = job.result?.artifacts || [];
    const tracks = SCORE_TRACK_FILENAMES.flatMap((filename) => {
      const artifact = artifacts.find((item) => item.filename === filename);
      return artifact ? [{ filename, size: artifact.size_bytes }] : [];
    });
    if (!tracks.length) return failure(404, 'No BigWig score tracks are available for this task.');
    const size = scoreTracksZipSize(tracks);
    const fetched = await Promise.allSettled(tracks.map((track) => read(`/artifacts/${track.filename}`, request.method)));
    for (const result of fetched) if (result.status === 'fulfilled') responses.push(result.value);
    if (fetched.some((result) => result.status === 'rejected')) return failure(502, 'The score tracks could not be downloaded.');
    const failed = responses.find((response) => !response.ok);
    if (failed) return failure(failed.status, 'A score track is unavailable or has expired.');
    const headers = {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${SCORE_TRACKS_ZIP_FILENAME}"`,
      'Content-Length': String(size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.method === 'HEAD') return new Response(null, { headers });
    if (responses.some((response) => !response.body)) return failure(502, 'A score track has no download data.');
    const body = scoreTracksZipStream(tracks.map((track, index) => ({ ...track, body: responses[index].body! })));
    streaming = true;
    return new Response(body, { headers });
  } catch (error) {
    return failure(error instanceof RangeError ? 413 : 502, error instanceof RangeError ? error.message : 'The score tracks could not be downloaded.');
  } finally {
    if (!streaming) await Promise.allSettled(responses.map((response) => response.body?.cancel()));
  }
}

async function downloadTable(request: Request, jobId: string, token: string) {
  const base = serviceUrl(`/v1/jobs/${jobId}`);
  if (!base) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction service is not configured.' } }, { status: 503 });
  const read = (path: string, method = 'GET') => fetch(`${base}${path}`, {
    method, headers: { 'X-Job-Token': token }, cache: 'no-store', signal: request.signal,
  });
  const failure = (status: number, message: string) => Response.json({ error: { code: 'RESULT_TABLE_UNAVAILABLE', message } }, {
    status, headers: { 'Cache-Control': 'private, no-store' },
  });
  try {
    const jobResponse = await read('');
    if (!jobResponse.ok) return failure(jobResponse.status, 'Task access is invalid or its results have expired.');
    const job = await jobResponse.json() as { status: string; result?: { artifacts?: JobArtifact[] } };
    const artifacts = job.result?.artifacts || [];
    if (job.status !== 'succeeded') return failure(409, 'The prediction has not completed.');
    let summary: JobSummary = {};
    if (artifacts.some((item) => item.filename === 'summary.json')) {
      const response = await read('/artifacts/summary.json');
      if (!response.ok) return failure(response.status, 'The result summary is unavailable or has expired.');
      summary = await response.json();
      if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return failure(502, 'The result summary is invalid.');
    }
    const source = resultTableSource(artifacts, summary.mode);
    if (!source) return failure(404, 'TSV is unavailable for this task. Download the original result files.');
    let lengths = new Map<string, number>();
    if (source === 'scores.gff3' && artifacts.some((item) => item.filename === 'input.fasta.fai')) {
      const response = await read('/artifacts/input.fasta.fai');
      if (!response.ok) return failure(response.status, 'The reference index is unavailable or has expired.');
      lengths = parseReferenceLengths(await response.text());
    }
    const sourceResponse = await read(`/artifacts/${source}`, request.method);
    if (!sourceResponse.ok) return failure(sourceResponse.status, 'The source result file is unavailable or has expired.');
    const headers = {
      'Content-Type': 'text/tab-separated-values; charset=utf-8',
      'Content-Disposition': `attachment; filename="${RESULT_TABLE_FILENAME}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.method === 'HEAD') return new Response(null, { headers });
    if (!sourceResponse.body) return failure(502, 'The source result file is empty.');
    const body = await resultTableStream(sourceResponse.body, source === 'scores.gff3' ? 'gff3' : 'json', {
      windowLength: summary.model?.seq_length,
      coordinateSystem: windowCoordinateSystem(summary),
      sequenceLength: summary.mode === 'predict' ? summary.sequence_bases : undefined,
      lengths,
    });
    return new Response(body, { headers });
  } catch {
    return failure(502, 'The result table could not be read. The service or source file is unavailable or invalid.');
  }
}

async function proxy(request: Request, context: { params: Promise<{ jobId: string; filename: string }> }) {
  const { jobId, filename } = await context.params;
  if (!JOB_ID.test(jobId) || !FILE_NAME.test(filename)) {
    return Response.json({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found.' } }, { status: 404 });
  }
  const cookieName = `rapptor_job_${jobId}=`;
  const cookieToken = request.headers.get('cookie')?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(cookieName))
    ?.slice(cookieName.length);
  const token = request.headers.get('x-job-token') || decodeCookie(cookieToken);
  if (!token) return Response.json({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found.' } }, { status: 404 });
  if (filename === RESULT_TABLE_FILENAME) return downloadTable(request, jobId, token);
  if (filename === SCORE_TRACKS_ZIP_FILENAME) return downloadScoreTracks(request, jobId, token);
  const url = serviceUrl(`/v1/jobs/${jobId}/artifacts/${encodeURIComponent(filename)}`);
  if (!url) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction service is not configured.' } }, { status: 503 });
  const headers = new Headers({ 'X-Job-Token': token });
  const range = request.headers.get('range');
  if (range) headers.set('Range', range);
  try {
    const upstream = await fetch(url, { method: request.method, headers, cache: 'no-store' });
    const responseHeaders = new Headers();
    for (const name of ['accept-ranges', 'cache-control', 'content-disposition', 'content-length', 'content-range', 'content-type', 'etag']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction service is unavailable.' } }, { status: 503 });
  }
}

export function GET(request: Request, context: { params: Promise<{ jobId: string; filename: string }> }) {
  return proxy(request, context);
}

export function HEAD(request: Request, context: { params: Promise<{ jobId: string; filename: string }> }) {
  return proxy(request, context);
}
