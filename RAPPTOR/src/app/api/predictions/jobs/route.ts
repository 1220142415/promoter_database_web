import { predictionMaxRequestBytes } from '@/features/prediction/capabilities';

export const dynamic = 'force-dynamic';

function serviceUrl(path: string) {
  const base = process.env.RAPPTOR_PREDICTION_SERVICE_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : null;
}

export async function POST(request: Request) {
  const maxSubmissionBytes = predictionMaxRequestBytes();
  const url = serviceUrl('/v1/jobs');
  if (!url) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction service is not configured.' } }, { status: 503 });
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Ticket ')) {
    return Response.json({ error: { code: 'INVALID_TICKET', message: 'Prediction ticket is required.' } }, { status: 401 });
  }
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxSubmissionBytes) {
    return Response.json({ error: { code: 'INPUT_TOO_LARGE', message: 'Prediction request is too large.' } }, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > maxSubmissionBytes) {
    return Response.json({ error: { code: 'INPUT_TOO_LARGE', message: 'Prediction request is too large.' } }, { status: 413 });
  }
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction service is unavailable.' } }, { status: 503 });
  }
}
