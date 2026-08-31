export const dynamic = 'force-dynamic';

const JOB_ID = /^[0-9a-f]{32}$/;

function serviceUrl(path: string) {
  const base = process.env.RAPPTOR_PREDICTION_SERVICE_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : null;
}

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  if (!JOB_ID.test(jobId)) return Response.json({ error: { code: 'JOB_NOT_FOUND', message: 'Job not found.' } }, { status: 404 });
  const token = request.headers.get('x-job-token');
  if (!token) return Response.json({ error: { code: 'JOB_NOT_FOUND', message: 'Job not found.' } }, { status: 404 });
  const url = serviceUrl(`/v1/jobs/${jobId}`);
  if (!url) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction service is not configured.' } }, { status: 503 });
  try {
    const upstream = await fetch(url, { headers: { 'X-Job-Token': token }, cache: 'no-store' });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction service is unavailable.' } }, { status: 503 });
  }
}
