import { sendRappTorEmail, type ResendSettings } from './resend';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;
// Resend retains idempotency keys for 24 hours. Never retry ambiguous delivery beyond that window.
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

type Notification = {
  job_id: string;
  email: string;
  task_kind: 'predict' | 'genome_scan';
  outcome: 'succeeded' | 'failed';
  artifacts_expires_at: string | null;
  attempts: number;
};

export async function registerPredictionNotification(
  database: D1Database,
  jobId: string,
  user: { id: string; email: string; emailConfirmed: boolean },
  mode: 'predict' | 'genome_scan',
  now = new Date(),
) {
  if (!/^[0-9a-f]{32}$/.test(jobId) || !user.emailConfirmed || !user.id
    || user.email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user.email)) {
    throw new Error('Invalid prediction notification recipient or job.');
  }
  await database.prepare(`INSERT INTO prediction_job_notifications
      (job_id, user_id, email, task_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO NOTHING`)
    .bind(jobId, user.id, user.email, mode, now.toISOString(), now.toISOString())
    .run();
}

function notificationMessage(row: Notification) {
  const kind = row.task_kind === 'genome_scan' ? 'whole-genome scan' : 'short-sequence prediction';
  const status = row.outcome === 'succeeded' ? 'completed' : 'failed';
  const expiry = row.artifacts_expires_at ? Date.parse(row.artifacts_expires_at) : NaN;
  return {
    to: row.email,
    subject: `RAPPtor: ${kind} ${status}`,
    text: [
      `Your RAPPtor ${kind} has ${status}.`,
      `Task ID: ${row.job_id}`,
      row.outcome === 'succeeded' && Number.isFinite(expiry) ? `Results expire at: ${new Date(expiry).toISOString()} (UTC).` : '',
      row.outcome === 'failed' ? 'The task could not be completed. Open the task in your prediction history for details.' : '',
      'Return to the RAPPtor prediction page in the same browser used to submit this task.',
      'This email does not contain sequence data, result files, or an access token.',
    ].filter(Boolean).join('\n\n'),
    idempotencyKey: `prediction-completed/${row.job_id}`,
  };
}

export async function sendPredictionNotification(database: D1Database, jobId: string, settings: ResendSettings, now = new Date()) {
  // Missing configuration must not consume the finite retry budget.
  if (!settings.apiKey) return;
  const timestamp = now.toISOString();
  // Atomically lease one notification and freeze the payload for retries, even if callbacks arrive out of order.
  const row = await database.prepare(`UPDATE prediction_job_notifications SET
      status = 'sending', attempts = attempts + 1, updated_at = ?,
      first_attempt_at = COALESCE(first_attempt_at, ?),
      outcome = COALESCE(outcome, (SELECT status FROM prediction_jobs WHERE job_id = ?)),
      artifacts_expires_at = CASE WHEN first_attempt_at IS NULL
        THEN (SELECT artifacts_expires_at FROM prediction_jobs WHERE job_id = ?)
        ELSE artifacts_expires_at END
    WHERE job_id = ? AND status <> 'sent' AND attempts < ? AND created_at > ?
      AND (first_attempt_at IS NULL OR first_attempt_at > ?)
      AND (status = 'pending' OR updated_at <= ?)
      AND EXISTS (SELECT 1 FROM prediction_jobs j
        WHERE j.job_id = prediction_job_notifications.job_id
          AND j.mode = prediction_job_notifications.task_kind AND j.status IN ('succeeded', 'failed'))
    RETURNING job_id, email, task_kind, outcome, artifacts_expires_at, attempts`)
    .bind(timestamp, timestamp, jobId, jobId, jobId, MAX_ATTEMPTS,
      new Date(now.getTime() - RETENTION_MS).toISOString(),
      new Date(now.getTime() - RETRY_WINDOW_MS).toISOString(),
      new Date(now.getTime() - RETRY_DELAY_MS).toISOString())
    .first<Notification>();
  if (!row) return;

  const result = await sendRappTorEmail(settings, notificationMessage(row));
  await database.prepare(`UPDATE prediction_job_notifications SET
      status = ?, updated_at = ?, sent_at = ?, last_error = ?
    WHERE job_id = ? AND status = 'sending' AND attempts = ?`)
    .bind(result.ok ? 'sent' : 'failed', timestamp, result.ok ? timestamp : null,
      result.ok ? null : `${result.error}${result.providerStatus ? ` (HTTP ${result.providerStatus})` : ''}`,
      jobId, row.attempts)
    .run();
}

export async function retryPredictionNotifications(database: D1Database, settings: ResendSettings, now = new Date()) {
  const stale = new Date(now.getTime() - RETRY_DELAY_MS).toISOString();
  const retryCutoff = new Date(now.getTime() - RETRY_WINDOW_MS).toISOString();
  await database.prepare(`UPDATE prediction_job_notifications SET status = 'failed',
      last_error = 'Email delivery could not be confirmed within the retry limit.'
    WHERE status = 'sending' AND updated_at <= ? AND (attempts >= ? OR first_attempt_at <= ?)`)
    .bind(stale, MAX_ATTEMPTS, retryCutoff).run();
  if (!settings.apiKey) return;
  const rows = await database.prepare(`SELECT n.job_id FROM prediction_job_notifications n
    JOIN prediction_jobs j ON j.job_id = n.job_id AND j.mode = n.task_kind
    WHERE n.status <> 'sent' AND n.attempts < ? AND n.created_at > ?
      AND (n.first_attempt_at IS NULL OR n.first_attempt_at > ?)
      AND (n.status = 'pending' OR n.updated_at <= ?) AND j.status IN ('succeeded', 'failed')
    ORDER BY n.updated_at LIMIT 20`)
    .bind(MAX_ATTEMPTS, new Date(now.getTime() - RETENTION_MS).toISOString(), retryCutoff, stale)
    .all<{ job_id: string }>();
  for (const row of rows.results) {
    try {
      await sendPredictionNotification(database, row.job_id, settings, now);
    } catch {
      // Database exceptions may contain bound emails. Never log the exception itself.
      console.error(JSON.stringify({ event: 'prediction_notification_retry_failed', jobId: row.job_id }));
    }
  }
}

export async function purgeExpiredPredictionNotifications(database: D1Database, now = new Date()) {
  await database.prepare('DELETE FROM prediction_job_notifications WHERE created_at <= ?')
    .bind(new Date(now.getTime() - RETENTION_MS).toISOString()).run();
}
