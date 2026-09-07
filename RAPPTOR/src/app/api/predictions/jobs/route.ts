import { after } from 'next/server';
import { predictionMaxRequestBytes } from '@/features/prediction/capabilities';
import { requirePredictionAuth } from '@/features/email-system/supabase';
import { usageDatabase } from '@/features/usage/store';
import { releaseGenomeScanQuota, reserveGenomeScanQuota, secondsUntilBeijingMidnight } from '@/features/prediction/tickets';
import { registerPredictionNotification, sendPredictionNotification } from '@/features/email-system/prediction-notifications';

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
  if (mode !== 'predict' && mode !== 'genome_scan') {
    return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Prediction task mode is invalid.' } }, { status: 400 });
  }

  const now = new Date();
  const database = usageDatabase();
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

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body,
    });
  } catch {
    if (mode === 'genome_scan' && database) await releaseGenomeScanQuota(database, auth.id, now).catch(() => null);
    return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction service is unavailable.' } }, { status: 503 });
  }
  if (!upstream.ok && mode === 'genome_scan' && database) await releaseGenomeScanQuota(database, auth.id, now).catch(() => null);

  if (upstream.ok) {
    // The job is already queued. Notification failures must not discard its access token or refund its quota.
    try {
      const created = await upstream.clone().json() as { job_id?: unknown } | null;
      if (typeof created?.job_id !== 'string' || !/^[0-9a-f]{32}$/.test(created.job_id)) throw new Error('Invalid job ID.');
      const jobId = created.job_id;
      let registered = false;
      try {
        if (!database) throw new Error('Prediction notification database is unavailable.');
        await registerPredictionNotification(database, jobId, auth, mode, now);
        registered = true;
      } catch {
        console.error(JSON.stringify({ event: 'prediction_notification_registration_failed', jobId }));
      }
      after(async () => {
        try {
          // ponytail: one post-response registration retry; a sustained D1 outage needs a durable submission outbox.
          if (!database) return;
          if (!registered) await registerPredictionNotification(database, jobId, auth, mode, now);
          await sendPredictionNotification(database, jobId, { apiKey: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM, siteUrl: process.env.RAPPTOR_PUBLIC_SITE_URL });
        } catch {
          console.error(JSON.stringify({ event: 'prediction_notification_failed', jobId }));
        }
      });
    } catch {
      console.error(JSON.stringify({ event: 'prediction_notification_registration_failed' }));
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' },
  });
}
