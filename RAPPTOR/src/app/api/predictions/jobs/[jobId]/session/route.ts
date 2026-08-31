export const dynamic = 'force-dynamic';

const JOB_ID = /^[0-9a-f]{32}$/;

function serviceUrl(path: string) {
  const base = process.env.RAPPTOR_PREDICTION_SERVICE_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : null;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const token = request.headers.get('x-job-token');
  if (!JOB_ID.test(jobId) || !token || token.length > 200) {
    return Response.json({ authorized: false }, { status: 404 });
  }
  const url = serviceUrl(`/v1/jobs/${jobId}`);
  if (!url) return Response.json({ authorized: false }, { status: 503 });
  try {
    const upstream = await fetch(url, { method: 'GET', headers: { 'X-Job-Token': token }, cache: 'no-store' });
    if (!upstream.ok) return Response.json({ authorized: false }, { status: 404 });
    const secure = process.env.NODE_ENV === 'production' && process.env.RAPPTOR_DEPLOYMENT_ENV !== 'local' ? '; Secure' : '';
    return Response.json({ authorized: true }, {
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': `rapptor_job_${jobId}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict${secure}; Path=/api/predictions/jobs/${jobId}/artifacts; Max-Age=3600`,
      },
    });
  } catch {
    return Response.json({ authorized: false }, { status: 503 });
  }
}
