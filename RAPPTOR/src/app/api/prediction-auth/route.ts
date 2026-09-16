import { isEmail, NO_STORE, readJsonObject } from '@/features/email-system/http';
import {
  parseAuthSession,
  publicUser,
  readAuthSettings,
  readSessionCookie,
  supabaseAuth,
  supabaseUser,
  withClearedSession,
  withSessionCookie,
} from '@/features/email-system/supabase';
import { predictionAccessMode } from '@/features/email-system/access-mode';
import { usageDatabase } from '@/features/usage/store';
import { readPredictionBaseUsage } from '@/features/prediction/tickets';

export const dynamic = 'force-dynamic';

const error = (code: string, message: string, status: number) => Response.json(
  { authenticated: false, error: { code, message } },
  { status, headers: NO_STORE },
);

function authProviderError(value: unknown) {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(['code', 'error_code', 'msg', 'message']
    .filter((key) => typeof source[key] === 'string')
    .map((key) => [key, String(source[key]).slice(0, 200)]));
}

async function authenticatedPayload(user: { id: string; email: string; emailConfirmed: boolean }) {
  const database = usageDatabase();
  const quota = database ? await readPredictionBaseUsage(database, user.id).catch(() => undefined) : undefined;
  return { authenticated: true, user, quota };
}

export async function GET(request: Request) {
  if (predictionAccessMode() === 'ip') return error('AUTH_DISABLED', 'Email sign-in is disabled for this deployment.', 404);
  const settings = readAuthSettings();
  if (!settings) return error('AUTH_UNAVAILABLE', 'Prediction sign-in is not configured.', 503);
  const session = readSessionCookie(request);
  if (!session) return error('AUTH_REQUIRED', 'Sign in to use prediction.', 401);

  try {
    const current = await supabaseUser(settings, session.access_token);
    const user = current.response.ok ? publicUser(current.parsed) : null;
    if (user?.emailConfirmed) {
      return Response.json(await authenticatedPayload(user), { headers: NO_STORE });
    }

    const refreshed = await supabaseAuth(
      settings,
      'token?grant_type=refresh_token',
      { refresh_token: session.refresh_token },
    );
    const nextSession = refreshed.response.ok ? parseAuthSession(refreshed.parsed) : null;
    if (!nextSession?.user.emailConfirmed) {
      return withClearedSession(error('AUTH_REQUIRED', 'Sign in to use prediction.', 401));
    }
    return withSessionCookie(
      Response.json(await authenticatedPayload(nextSession.user), { headers: NO_STORE }),
      nextSession,
    );
  } catch {
    return error('AUTH_UNAVAILABLE', 'Prediction sign-in could not be reached.', 503);
  }
}

export async function POST(request: Request) {
  if (predictionAccessMode() === 'ip') return error('AUTH_DISABLED', 'Email sign-in is disabled for this deployment.', 404);
  const body = await readJsonObject(request);
  const action = body?.action;

  if (action === 'logout') {
    const settings = readAuthSettings();
    const session = readSessionCookie(request);
    if (settings && session) {
      await supabaseAuth(settings, 'logout', {}, session.access_token).catch(() => null);
    }
    return withClearedSession(Response.json({ authenticated: false }, { headers: NO_STORE }));
  }

  const settings = readAuthSettings();
  if (!settings) return error('AUTH_UNAVAILABLE', 'Prediction sign-in is not configured.', 503);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : body?.email;
  if ((action !== 'send-code' && action !== 'verify-code') || !isEmail(email)) {
    return error('INVALID_AUTH_REQUEST', 'Enter a valid email address.', 400);
  }

  try {
    if (action === 'send-code') {
      const result = await supabaseAuth(settings, 'otp', { email, create_user: true });
      if (!result.response.ok) {
        console.error(JSON.stringify({
          event: 'prediction_auth_otp_failed',
          providerStatus: result.response.status,
          providerError: authProviderError(result.parsed),
        }));
        return error('OTP_SEND_FAILED', 'Verification code could not be sent. Try again shortly.', 400);
      }
      return Response.json({ authenticated: false, codeSent: true }, { status: 202, headers: NO_STORE });
    }

    const token = typeof body?.token === 'string' ? body.token.trim() : body?.token;
    if (typeof token !== 'string' || !/^\d{6}$/.test(token)) {
      return error('INVALID_AUTH_REQUEST', 'Enter the 6-digit verification code.', 400);
    }
    const result = await supabaseAuth(settings, 'verify', { type: 'email', email, token });
    if (!result.response.ok) {
      return error('INVALID_CODE', 'The verification code is invalid or has expired.', 401);
    }

    const session = parseAuthSession(result.parsed);
    if (!session) return error('AUTH_PROVIDER_ERROR', 'Verification returned no session.', 502);
    if (!session.user.emailConfirmed) {
      return withClearedSession(error('EMAIL_CONFIRMATION_REQUIRED', 'Email verification was not completed.', 403));
    }
    return withSessionCookie(
      Response.json(await authenticatedPayload(session.user), { headers: NO_STORE }),
      session,
    );
  } catch {
    return error('AUTH_UNAVAILABLE', 'Prediction sign-in could not be reached.', 503);
  }
}
