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
  access_token_ciphertext: string | null;
  reference_name: string | null;
  attempts: number;
};

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string) {
  const encoded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

async function tokenKey(secret: string, usage: KeyUsage[]) {
  if (secret.length < 32) throw new Error('Prediction notification token secret is invalid.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, usage);
}

async function encryptAccessToken(token: string, secret: string, jobId: string) {
  if (!/^[A-Za-z0-9_-]{32,200}$/u.test(token)) throw new Error('Prediction access token is invalid.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(jobId) },
    await tokenKey(secret, ['encrypt']),
    new TextEncoder().encode(token),
  );
  return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

async function decryptAccessToken(value: string, secret: string, jobId: string) {
  const [iv, encrypted, extra] = value.split('.');
  if (!iv || !encrypted || extra) throw new Error('Prediction notification token is invalid.');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: new TextEncoder().encode(jobId) },
    await tokenKey(secret, ['decrypt']),
    fromBase64Url(encrypted),
  );
  return new TextDecoder().decode(decrypted);
}

export async function registerPredictionNotification(
  database: D1Database,
  jobId: string,
  user: { id: string; email: string; emailConfirmed: boolean },
  mode: 'predict' | 'genome_scan',
  access: { token: string; tokenSecret: string; referenceName?: string | null },
  now = new Date(),
) {
  if (!/^[0-9a-f]{32}$/.test(jobId) || !user.emailConfirmed || !user.id
    || user.email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user.email)) {
    throw new Error('Invalid prediction notification recipient or job.');
  }
  const encryptedToken = await encryptAccessToken(access.token, access.tokenSecret, jobId);
  const referenceName = access.referenceName?.trim().slice(0, 200) || null;
  await database.prepare(`INSERT INTO prediction_job_notifications
      (job_id, user_id, email, task_kind, access_token_ciphertext, reference_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO NOTHING`)
    .bind(jobId, user.id, user.email, mode, encryptedToken, referenceName, now.toISOString(), now.toISOString())
    .run();
}

function notificationMessage(row: Notification, siteUrl?: string, accessToken?: string) {
  const kind = row.task_kind === 'genome_scan' ? 'whole-genome scan' : 'short-sequence prediction';
  const status = row.outcome === 'succeeded' ? 'completed' : 'failed';
  const successful = row.outcome === 'succeeded';
  const expiry = row.artifacts_expires_at ? Date.parse(row.artifacts_expires_at) : NaN;
  let resultUrl: string | null = null;
  try {
    const url = new URL(`/predict/task/${row.job_id}`, siteUrl);
    if (url.protocol === 'https:' && accessToken) {
      url.hash = new URLSearchParams({ access: accessToken, ...(row.reference_name ? { ref: row.reference_name } : {}) }).toString();
      resultUrl = url.toString();
    }
  } catch { /* Invalid deployment URL: retain the plain prediction-page fallback. */ }
  const expiryText = successful && Number.isFinite(expiry) ? `Results expire at: ${new Date(expiry).toISOString()} (UTC).` : '';
  const title = successful ? 'Your prediction is ready' : 'Your prediction could not be completed';
  const accent = successful ? '#176b60' : '#9f3a38';
  const badge = successful ? 'RESULT READY' : 'TASK FAILED';
  const safeHref = resultUrl?.replaceAll('&', '&amp;');
  return {
    to: row.email,
    subject: `RAPPtor: ${kind} ${status}`,
    text: [
      `Your RAPPtor ${kind} has ${status}.`,
      `Task ID: ${row.job_id}`,
      expiryText,
      row.outcome === 'failed' ? 'The task could not be completed. Open the task in your prediction history for details.' : '',
      resultUrl ? `Open this task: ${resultUrl}` : 'Return to the RAPPtor prediction page in the same browser used to submit this task.',
      resultUrl ? 'Anyone with this temporary link can view the result until it expires. Keep it private.' : '',
      'This email does not contain sequence data or result files.',
    ].filter(Boolean).join('\n\n'),
    html: `<div style="margin:0;padding:32px 16px;background:#f2f6f5;font-family:Arial,sans-serif;color:#17312f"><div style="max-width:620px;margin:auto;overflow:hidden;border:1px solid #dbe6e3;border-radius:14px;background:#ffffff;box-shadow:0 10px 30px rgba(23,49,47,.08)"><div style="padding:22px 30px;border-bottom:1px solid #e5ecea;background:#17312f;color:#ffffff"><div style="font-family:Georgia,serif;font-size:26px;letter-spacing:.02em">RAPPtor</div><div style="margin-top:4px;color:#b9d9d2;font-size:12px;letter-spacing:.08em;text-transform:uppercase">Promoter prediction</div></div><div style="padding:34px 30px"><div style="display:inline-block;padding:6px 10px;border-radius:999px;background:${successful ? '#e6f4ef' : '#fbeceb'};color:${accent};font-size:11px;font-weight:800;letter-spacing:.08em">${badge}</div><h1 style="margin:18px 0 10px;font-family:Georgia,serif;font-size:32px;line-height:1.2;font-weight:600">${title}</h1><p style="margin:0 0 24px;color:#55706d;font-size:15px;line-height:1.7">Your RAPPtor ${kind} has ${status}.</p><div style="margin:0 0 26px;padding:16px;border-radius:9px;background:#f7faf9"><div style="color:#78908d;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">Task ID</div><div style="margin-top:6px;font-family:Consolas,monospace;font-size:13px;overflow-wrap:anywhere">${row.job_id}</div>${expiryText ? `<div style="margin-top:12px;color:#55706d;font-size:13px">${expiryText}</div>` : ''}</div>${safeHref ? `<a href="${safeHref}" style="display:inline-block;padding:13px 20px;border-radius:7px;background:${accent};color:#ffffff;text-decoration:none;font-size:14px;font-weight:800">${successful ? 'Open genome browser' : 'View task details'}</a>` : ''}${resultUrl ? '<p style="margin:24px 0 0;color:#7a5654;font-size:12px;line-height:1.6">This is a private capability link. Anyone you share it with can view the temporary result until it expires.</p>' : ''}<p style="margin:16px 0 0;color:#78908d;font-size:12px;line-height:1.6">No sequence data or result files are included in this email.</p></div></div><p style="max-width:620px;margin:18px auto 0;color:#78908d;font-size:11px;text-align:center">RAPPtor · Research use only</p></div>`,
    idempotencyKey: `prediction-completed/${row.job_id}`,
  };
}

export async function sendPredictionNotification(database: D1Database, jobId: string, settings: ResendSettings, now = new Date()) {
  // Missing configuration must not consume the finite retry budget.
  if (!settings.apiKey || !settings.tokenSecret) return;
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
    RETURNING job_id, email, task_kind, outcome, artifacts_expires_at,
      access_token_ciphertext, reference_name, attempts`)
    .bind(timestamp, timestamp, jobId, jobId, jobId, MAX_ATTEMPTS,
      new Date(now.getTime() - RETENTION_MS).toISOString(),
      new Date(now.getTime() - RETRY_WINDOW_MS).toISOString(),
      new Date(now.getTime() - RETRY_DELAY_MS).toISOString())
    .first<Notification>();
  if (!row) return;

  const accessToken = row.access_token_ciphertext
    ? await decryptAccessToken(row.access_token_ciphertext, settings.tokenSecret, row.job_id)
    : undefined;
  const result = await sendRappTorEmail(settings, notificationMessage(row, settings.siteUrl, accessToken));
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
  if (!settings.apiKey || !settings.tokenSecret) return;
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
