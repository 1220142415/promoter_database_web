import type { PredictionQueueStatus } from '@/features/prediction/progress';

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
    if (upstream.ok) {
      const job = await upstream.json() as { status?: string; mode?: string; queue?: PredictionQueueStatus };
      if (job.status === 'queued') {
        // Enrich the existing poll; the browser does not need a second request.
        try {
          const response = await fetch(serviceUrl('/v1/status')!, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
          if (response.ok && (job.mode === 'predict' || job.mode === 'genome_scan')) {
            const service = await response.json() as {
              workload?: { running?: Record<string, { jobs?: unknown }> };
              workers?: Record<string, unknown>;
            };
            const running = service?.workload?.running?.[job.mode]?.jobs;
            const ready = service?.workers?.[job.mode];
            job.queue = {
              ...job.queue,
              running: typeof running === 'number' && Number.isSafeInteger(running) && running >= 0 ? running : null,
              worker_ready: typeof ready === 'boolean' ? ready : null,
            };
          }
        } catch {
          // Optional load data must not prevent access to the task's status.
        }
      }
      return Response.json(job, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction service is unavailable.' } }, { status: 503 });
  }
}
