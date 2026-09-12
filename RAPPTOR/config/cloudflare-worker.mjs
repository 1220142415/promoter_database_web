import openNextWorker from '../.open-next/worker.js';
import { purgeExpiredUsage } from '../src/features/usage/retention.ts';
import { purgeExpiredPredictionNotifications, retryPredictionNotifications } from '../src/features/email-system/prediction-notifications.ts';
import { predictionAccessMode } from '../src/features/email-system/access-mode.ts';

const DEFAULT_RETENTION_DAYS = 400;

async function runRetentionCleanup(env, scheduledTime) {
  const configured = Number(env.RAPPTOR_ANALYTICS_RETENTION_DAYS);
  const retentionDays = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_RETENTION_DAYS;
  const day = new Date(scheduledTime).toISOString().slice(0, 10);
  if (env.RAPPTOR_DB) await purgeExpiredUsage(env.RAPPTOR_DB, day, retentionDays);
}

async function fetchWithCatalogCache(request, env, context) {
  const url = new URL(request.url);
  const cacheable = request.method === 'GET'
    && url.pathname === '/api/genomes'
    && !['domain', 'phylum', 'class', 'order', 'family', 'genus'].some((rank) => url.searchParams.has(rank))
    && !request.headers.has('authorization')
    && !env.RAPPTOR_DEMO_USERNAME
    && !env.RAPPTOR_DEMO_PASSWORD;
  if (!cacheable) return openNextWorker.fetch(request, env, context);
  const cacheUrl = new URL(url);
  cacheUrl.searchParams.set('__rapptor_version', env.CF_VERSION_METADATA?.id || 'local');
  const key = new Request(cacheUrl.toString(), { method: 'GET' });
  const hit = await caches.default.match(key);
  if (hit) {
    const response = new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: new Headers(hit.headers) });
    response.headers.set('X-RAPPTOR-Cache', 'HIT');
    return response;
  }
  const response = await openNextWorker.fetch(request, env, context);
  if (response.ok) {
    const cached = response.clone();
    const headers = new Headers(cached.headers);
    headers.set('Cache-Control', 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800');
    context.waitUntil(caches.default.put(key, new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers })));
  }
  const delivered = new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
  delivered.headers.set('X-RAPPTOR-Cache', 'MISS');
  return delivered;
}

async function fetchWithUsageCache(request, env, context) {
  const url = new URL(request.url);
  const cacheable = request.method === 'GET'
    && url.pathname === '/usage'
    && (request.headers.get('sec-fetch-dest') === 'document'
      || (!request.headers.has('RSC') && request.headers.get('accept')?.includes('text/html')))
    && !request.headers.has('next-router-prefetch')
    && request.headers.get('purpose') !== 'prefetch'
    && request.headers.get('sec-purpose')?.includes('prefetch') !== true
    && !request.headers.has('authorization')
    && env.RAPPTOR_USAGE_PUBLIC_PAGE?.toLowerCase() === 'on';
  if (!cacheable) return openNextWorker.fetch(request, env, context);

  // A versioned daily key makes the first request of each UTC day refresh the
  // aggregate report; every later visitor receives the cached static HTML.
  const cacheUrl = new URL(url);
  cacheUrl.searchParams.set('__rapptor_usage_day', new Date().toISOString().slice(0, 10));
  const key = new Request(cacheUrl.toString(), { method: 'GET' });
  const hit = await caches.default.match(key);
  if (hit) {
    const response = new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: new Headers(hit.headers) });
    response.headers.set('X-RAPPTOR-Usage-Cache', 'HIT');
    return response;
  }

  const response = await openNextWorker.fetch(request, env, context);
  if (response.ok) {
    const cached = response.clone();
    const headers = new Headers(cached.headers);
    headers.set('Cache-Control', 'public, max-age=0, s-maxage=86400, stale-while-revalidate=86400');
    context.waitUntil(caches.default.put(key, new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers })));
  }
  const delivered = new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
  delivered.headers.set('X-RAPPTOR-Usage-Cache', 'MISS');
  return delivered;
}

const worker = {
  fetch(request, env, context) {
    return new URL(request.url).pathname === '/usage'
      ? fetchWithUsageCache(request, env, context)
      : fetchWithCatalogCache(request, env, context);
  },
  scheduled(controller, env, context) {
    if (controller.cron === '17 3 * * *') {
      context.waitUntil(runRetentionCleanup(env, controller.scheduledTime));
    }
    if (env.RAPPTOR_DB) {
      context.waitUntil((async () => {
        const now = new Date(controller.scheduledTime);
        await purgeExpiredPredictionNotifications(env.RAPPTOR_DB, now);
        if (predictionAccessMode(env.RAPPTOR_PREDICTION_ACCESS_MODE) === 'email') {
          await retryPredictionNotifications(env.RAPPTOR_DB, {
            apiKey: env.RESEND_API_KEY,
            from: env.RESEND_FROM,
            siteUrl: env.RAPPTOR_PUBLIC_SITE_URL,
            tokenSecret: env.RAPPTOR_PREDICTION_SERVICE_SECRET,
          }, now);
        }
      })().catch(() => {
        console.error(JSON.stringify({ event: 'prediction_notification_cron_failed' }));
      }));
    }
  },
};

export default worker;
