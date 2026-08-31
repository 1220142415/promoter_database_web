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
