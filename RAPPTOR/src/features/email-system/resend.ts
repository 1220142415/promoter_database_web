import { reserveDailyEmail } from './otp-rate-limit';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'RAPPtor <no-reply@auth.email.duolalab.qzz.io>';

// Used only by server routes and the Cron handler, which passes Worker bindings explicitly.
export type ResendSettings = { apiKey?: string; from?: string; siteUrl?: string; tokenSecret?: string; database?: D1Database; emailsPerDay?: string; dailyBudgetReserved?: boolean };
export type EmailMessage = { from?: string; to: string; subject: string; text: string; html?: string; idempotencyKey?: string };

export type ResendResult =
  | { ok: true; messageId: string }
  | { ok: false; status: 429 | 502 | 503; providerStatus?: number; error: string; deferred?: boolean; retryAfter?: number };

export async function sendRappTorEmail(settings: ResendSettings, message: EmailMessage): Promise<ResendResult> {
  if (!settings.apiKey) return { ok: false, status: 503, error: 'Email notifications are not configured.' };
  if (message.to.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(message.to)) {
    return { ok: false, status: 502, error: 'Notification recipient is invalid.' };
  }

  if (!settings.database) return { ok: false, status: 503, error: 'Email quota database is unavailable.' };
  try {
    // The OTP route reserves before generating a replacement code. Other senders reserve here.
    if (!settings.dailyBudgetReserved) {
      const budget = await reserveDailyEmail(settings.database, settings.emailsPerDay || process.env.RAPPTOR_EMAILS_PER_DAY);
      if (!budget.allowed) return { ok: false, status: 429, deferred: true, error: budget.message, retryAfter: budget.retryAfter };
    }
  } catch {
    return { ok: false, status: 503, deferred: true, error: 'Email quota could not be checked.' };
  }

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
        ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: message.from || settings.from || DEFAULT_FROM, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 502, error: 'Resend could not be reached.' };
  }
  if (!response.ok) return { ok: false, status: 502, providerStatus: response.status, error: 'Resend rejected the message.' };

  const result = await response.json().catch(() => null) as { id?: unknown } | null;
  if (typeof result?.id !== 'string' || !result.id) return { ok: false, status: 502, error: 'Resend returned no message ID.' };
  return { ok: true, messageId: result.id.length > 12 ? `${result.id.slice(0, 8)}…${result.id.slice(-4)}` : 'accepted' };
}
