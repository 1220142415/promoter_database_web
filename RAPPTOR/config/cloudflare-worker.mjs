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

const worker = {
  fetch(request, env, context) {
    return openNextWorker.fetch(request, env, context);
  },
  scheduled(controller, env, context) {
    context.waitUntil(runRetentionCleanup(env, controller.scheduledTime));
  },
};

export default worker;
