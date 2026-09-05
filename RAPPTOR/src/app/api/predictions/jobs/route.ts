import { predictionMaxRequestBytes } from '@/features/prediction/capabilities';
import { requirePredictionAuth } from '@/features/auth/supabase';
import { usageDatabase } from '@/features/usage/store';
import { releaseGenomeScanQuota, reserveGenomeScanQuota, secondsUntilBeijingMidnight } from '@/features/prediction/tickets';

export const dynamic = 'force-dynamic';

function serviceUrl(path: string) {
  const base = process.env.RAPPTOR_PREDICTION_SERVICE_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : null;
}

export async function POST(request: Request) {
  const auth = await requirePredictionAuth(request);
  if (auth instanceof Response) return auth;
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
  let mode: unknown;
  try {
    mode = (JSON.parse(new TextDecoder().decode(body)) as { mode?: unknown }).mode;
  } catch {
    return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Prediction request is invalid.' } }, { status: 400 });
  }

  const now = new Date();
  const database = mode === 'genome_scan' ? usageDatabase() : null;
  if (mode === 'genome_scan') {
    if (!database) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction quota database is unavailable.' } }, { status: 503 });
    try {
      if (!await reserveGenomeScanQuota(database, auth.id, now)) {
        return Response.json(
          { error: { code: 'DAILY_GENOME_SCAN_LIMIT', message: 'The daily whole-genome scan quota has been used. Try again after 00:00 Beijing time.' } },
          { status: 429, headers: { 'Retry-After': String(secondsUntilBeijingMidnight(now)), 'Cache-Control': 'no-store' } },
        );
      }
    } catch {
      return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction quota could not be checked.' } }, { status: 503 });
    }
  }

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body,
    });
    if (!upstream.ok && database) await releaseGenomeScanQuota(database, auth.id, now).catch(() => null);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    if (database) await releaseGenomeScanQuota(database, auth.id, now).catch(() => null);
    return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction service is unavailable.' } }, { status: 503 });
  }
}
