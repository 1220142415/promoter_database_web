import openNextWorker from '../.open-next/worker.js';
import { purgeExpiredUsage } from '../src/features/usage/retention.ts';

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

const worker = {
  fetch(request, env, context) {
    return fetchWithCatalogCache(request, env, context);
  },
  scheduled(controller, env, context) {
    context.waitUntil(runRetentionCleanup(env, controller.scheduledTime));
  },
};

export default worker;
