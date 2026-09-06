const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'RAPPtor <no-reply@auth.email.duolalab.qzz.io>';

// Used only by server routes and the Cron handler, which passes Worker bindings explicitly.
export type ResendSettings = { apiKey?: string; from?: string };
type EmailMessage = { to: string; subject: string; text: string; idempotencyKey?: string };

export type ResendResult =
  | { ok: true; messageId: string }
  | { ok: false; status: 502 | 503; providerStatus?: number; error: string };

export async function sendRappTorEmail(settings: ResendSettings, message: EmailMessage): Promise<ResendResult> {
  if (!settings.apiKey) return { ok: false, status: 503, error: 'Email notifications are not configured.' };
  if (message.to.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(message.to)) {
    return { ok: false, status: 502, error: 'Notification recipient is invalid.' };
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
      body: JSON.stringify({ from: settings.from || DEFAULT_FROM, to: [message.to], subject: message.subject, text: message.text }),
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
