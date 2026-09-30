// Shared by server routes and the Cron handler, which supplies D1 and limits explicitly.
export const OTP_SEND_COOLDOWN_SECONDS = 60;

function dailyLimit(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function reserveDailyBudget(database: D1Database, scope: string, limit: number, cooldown: number, now: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  // One conditional upsert reserves the budget atomically across Worker instances.
  // Failed or ambiguous sends consume reservations so they cannot bypass the cap.
  const reserved = await database.prepare(`INSERT INTO auth_email_limits
      (scope, day, count, next_send_at, updated_at) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      day = excluded.day,
      count = CASE WHEN auth_email_limits.day = excluded.day THEN auth_email_limits.count + 1 ELSE 1 END,
      next_send_at = excluded.next_send_at, updated_at = excluded.updated_at
    WHERE auth_email_limits.next_send_at <= ?
      AND (auth_email_limits.day <> excluded.day OR auth_email_limits.count < ?)
    RETURNING scope`)
    .bind(scope, day, now + cooldown, now, now, limit).first();
  if (reserved) return { allowed: true, retryAfter: Math.ceil(cooldown / 1000), message: '' };
  const current = await database.prepare('SELECT day, count, next_send_at FROM auth_email_limits WHERE scope = ?')
    .bind(scope).first<{ day: string; count: number; next_send_at: number }>();
  const dailyExceeded = current?.day === day && current.count >= limit;
  const retryAt = dailyExceeded ? midnight : current?.next_send_at || now + 60_000;
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((retryAt - now) / 1000)),
    message: dailyExceeded
      ? 'The daily email limit has been reached. Try again after 08:00 Beijing time.'
      : 'Wait 60 seconds before requesting another code for this email address.',
  };
}

// The Resend Free plan permits 100 recipients/day. All RAPPTOR email paths share this bucket.
export function reserveDailyEmail(database: D1Database, configuredLimit?: string, now = Date.now()) {
  return reserveDailyBudget(database, 'global', Math.min(100, dailyLimit(configuredLimit, 100)), 0, now);
}

export async function reserveVerificationEmail(
  database: D1Database, secret: string, email: string, now = Date.now(),
) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(email)));
  const emailKey = `email/${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return reserveDailyBudget(database, emailKey,
    dailyLimit(process.env.RAPPTOR_AUTH_EMAILS_PER_ADDRESS_PER_DAY, 10), OTP_SEND_COOLDOWN_SECONDS * 1000, now);
}
