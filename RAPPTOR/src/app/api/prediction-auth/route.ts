import { isEmail, NO_STORE, readJsonObject } from '@/features/auth/http';
import {
  parseAuthSession,
  publicUser,
  readAuthSettings,
  readSessionCookie,
  supabaseAuth,
  supabaseUser,
  withClearedSession,
  withSessionCookie,
} from '@/features/auth/supabase';

export const dynamic = 'force-dynamic';

const error = (code: string, message: string, status: number) => Response.json(
  { authenticated: false, error: { code, message } },
  { status, headers: NO_STORE },
);

export async function GET(request: Request) {
  const settings = readAuthSettings();
  if (!settings) return error('AUTH_UNAVAILABLE', 'Prediction sign-in is not configured.', 503);
  const session = readSessionCookie(request);
  if (!session) return error('AUTH_REQUIRED', 'Sign in to use prediction.', 401);

  try {
    const current = await supabaseUser(settings, session.access_token);
    const user = current.response.ok ? publicUser(current.parsed) : null;
    if (user?.emailConfirmed) {
      return Response.json({ authenticated: true, user }, { headers: NO_STORE });
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
      Response.json({ authenticated: true, user: nextSession.user }, { headers: NO_STORE }),
      nextSession,
    );
  } catch {
    return error('AUTH_UNAVAILABLE', 'Prediction sign-in could not be reached.', 503);
  }
}

export async function POST(request: Request) {
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
      if (!result.response.ok) return error('OTP_SEND_FAILED', 'Verification code could not be sent. Try again shortly.', 400);
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
      Response.json({ authenticated: true, user: session.user }, { headers: NO_STORE }),
      session,
    );
  } catch {
    return error('AUTH_UNAVAILABLE', 'Prediction sign-in could not be reached.', 503);
  }
}
