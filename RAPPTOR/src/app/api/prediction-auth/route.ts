import { isEmail, NO_STORE, readJsonObject } from '@/features/email-system/http';
import { currentPredictionUser, predictionAuth, readBetterAuthSettings } from '@/features/email-system/better-auth';
import { predictionAccessMode } from '@/features/email-system/access-mode';
import { usageDatabase } from '@/features/usage/store';
import { readPredictionBaseUsage } from '@/features/prediction/tickets';
import { OTP_SEND_COOLDOWN_SECONDS, reserveDailyEmail, reserveVerificationEmail } from '@/features/email-system/otp-rate-limit';

export const dynamic = 'force-dynamic';

const error = (code: string, message: string, status: number) => Response.json(
  { authenticated: false, error: { code, message } },
  { status, headers: NO_STORE },
);

async function authenticatedPayload(user: { id: string; email: string; emailConfirmed: boolean }) {
  const database = usageDatabase();
  const quota = database ? await readPredictionBaseUsage(database, user.id).catch(() => undefined) : undefined;
  return { authenticated: true, user, quota };
}

async function authRequest(request: Request, path: string, body: Record<string, unknown>, dailyEmailBudgetReserved = false) {
  const auth = predictionAuth(request, dailyEmailBudgetReserved);
  if (!auth) return null;
  const url = new URL(`/api/auth/${path}`, request.url);
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return auth.handler(new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }));
}

function copyCookies(source: Response, target: Response) {
  for (const cookie of source.headers.getSetCookie()) target.headers.append('Set-Cookie', cookie);
  return target;
}

async function verificationError(result: Response | null) {
  if (!result || result.status >= 500) return error('AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Try again shortly.', 503);
  if (result.status === 429) return error('AUTH_RATE_LIMITED', 'Too many verification requests. Wait a minute and try again.', 429);
  const payload = await result.json().catch(() => null) as { code?: unknown } | null;
  if (payload?.code === 'OTP_EXPIRED') return error('CODE_EXPIRED', 'This code has expired. Request a new verification code.', 401);
  if (payload?.code === 'TOO_MANY_ATTEMPTS') return error('CODE_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Request a new verification code.', 401);
  if (payload?.code === 'INVALID_OTP') return error('INVALID_CODE', 'This code is incorrect, already used, or replaced by a newer code. Use the latest email or request a new code.', 401);
  if (payload?.code === 'INVALID_ORIGIN' || payload?.code === 'MISSING_OR_NULL_ORIGIN') {
    return error('AUTH_ORIGIN_REJECTED', 'Reload the RAPPTOR sign-in page and try again.', 403);
  }
  return error('AUTH_UNAVAILABLE', 'Sign-in could not be completed. Try again shortly.', 503);
}

function rateLimited(message: string, retryAfter: number) {
  const response = error('AUTH_RATE_LIMITED', message, 429);
  response.headers.set('Retry-After', String(retryAfter));
  return response;
}

export async function GET(request: Request) {
  if (predictionAccessMode() === 'ip') return error('AUTH_DISABLED', 'Email sign-in is disabled for this deployment.', 404);
  if (!readBetterAuthSettings()) return error('AUTH_UNAVAILABLE', 'Prediction sign-in is not configured.', 503);
  try {
    const headers = new Headers(NO_STORE);
    const user = await currentPredictionUser(request, headers);
    const response = user ? Response.json(await authenticatedPayload(user), { headers })
      : error('AUTH_REQUIRED', 'Sign in to use prediction.', 401);
    if (!user) for (const cookie of headers.getSetCookie()) response.headers.append('Set-Cookie', cookie);
    return response;
  } catch {
    return error('AUTH_UNAVAILABLE', 'Prediction sign-in could not be reached.', 503);
  }
}

export async function POST(request: Request) {
  if (predictionAccessMode() === 'ip') return error('AUTH_DISABLED', 'Email sign-in is disabled for this deployment.', 404);
  const body = await readJsonObject(request);
  const action = body?.action;
  if (action === 'logout') {
    try {
      const result = await authRequest(request, 'sign-out', {});
      if (!result?.ok) return error('AUTH_UNAVAILABLE', 'Sign-out could not be completed.', 503);
      const response = Response.json({ authenticated: false }, { headers: NO_STORE });
      response.headers.append('Set-Cookie', 'rapptor_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
      return copyCookies(result, response);
    } catch {
      return error('AUTH_UNAVAILABLE', 'Sign-out could not be completed.', 503);
    }
  }

  if (!readBetterAuthSettings()) return error('AUTH_UNAVAILABLE', 'Prediction sign-in is not configured.', 503);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : body?.email;
  if ((action !== 'send-code' && action !== 'verify-code') || !isEmail(email)) {
    return error('INVALID_AUTH_REQUEST', 'Enter a valid email address.', 400);
  }
  try {
    if (action === 'send-code') {
      const settings = readBetterAuthSettings();
      if (!settings?.apiKey || !settings.from) return error('AUTH_UNAVAILABLE', 'Verification email is temporarily unavailable.', 503);
      const expectedOrigin = new URL(process.env.RAPPTOR_PUBLIC_SITE_URL?.trim() || request.url).origin;
      const origin = request.headers.get('origin');
      if ((origin && origin !== expectedOrigin) || request.headers.get('sec-fetch-site') === 'cross-site') {
        return error('AUTH_ORIGIN_REJECTED', 'Reload the RAPPTOR sign-in page and try again.', 403);
      }
      const reservation = await reserveVerificationEmail(settings.database, settings.secret, email);
      if (!reservation.allowed) return rateLimited(reservation.message, reservation.retryAfter);
      // Reject a full shared budget before Better Auth stores a code that replaces the last email.
      const budget = await reserveDailyEmail(settings.database, process.env.RAPPTOR_EMAILS_PER_DAY);
      if (!budget.allowed) return rateLimited(budget.message, budget.retryAfter);
      const result = await authRequest(request, 'email-otp/send-verification-otp', { email, type: 'sign-in' }, true);
      if (result?.status === 429) {
        const failure = await result.json().catch(() => null) as { code?: string } | null;
        return rateLimited(failure?.code === 'EMAIL_DAILY_LIMIT'
          ? 'The site daily email limit has been reached. Try again after 08:00 Beijing time.'
          : 'Too many requests. Wait before requesting another code.',
        Number(result.headers.get('Retry-After') || result.headers.get('X-Retry-After')) || OTP_SEND_COOLDOWN_SECONDS);
      }
      if (!result?.ok) return error('OTP_SEND_FAILED', 'Verification code could not be sent. Wait a minute and request a new code.', 503);
      return Response.json({ authenticated: false, codeSent: true, retryAfter: OTP_SEND_COOLDOWN_SECONDS, expiresIn: 600 },
        { status: 202, headers: NO_STORE });
    }

    const token = typeof body?.token === 'string' ? body.token.trim() : body?.token;
    if (typeof token !== 'string' || !/^\d{6}$/.test(token)) {
      return error('INVALID_AUTH_REQUEST', 'Enter the 6-digit verification code.', 400);
    }
    // A retry from an already signed-in browser must not reuse its consumed OTP.
    const signedInUser = await currentPredictionUser(request);
    if (signedInUser?.email === email) return Response.json(await authenticatedPayload(signedInUser), { headers: NO_STORE });
    const result = await authRequest(request, 'sign-in/email-otp', { email, otp: token });
    if (!result?.ok) return verificationError(result);
    const payload = await result.json().catch(() => null) as { user?: { id?: unknown; email?: unknown; emailVerified?: unknown } } | null;
    const user = payload?.user;
    if (typeof user?.id !== 'string' || typeof user.email !== 'string' || user.emailVerified !== true) {
      return error('AUTH_PROVIDER_ERROR', 'Verification returned no confirmed user.', 502);
    }
    const response = Response.json(await authenticatedPayload({ id: user.id, email: user.email, emailConfirmed: true }), { headers: NO_STORE });
    response.headers.append('Set-Cookie', 'rapptor_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return copyCookies(result, response);
  } catch {
    return error('AUTH_UNAVAILABLE', 'Prediction sign-in could not be reached.', 503);
  }
}
