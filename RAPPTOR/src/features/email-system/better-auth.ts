import 'server-only';

import { betterAuth } from 'better-auth/minimal';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import { usageDatabase } from '@/features/usage/store';
import { sendRappTorEmail } from './resend';
import { verificationEmail } from './verification-email';
import * as schema from './better-auth-schema';

export type PublicAuthUser = { id: string; email: string; emailConfirmed: boolean };

export function readBetterAuthSettings() {
  const database = usageDatabase();
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim();
  if (!database || !secret || secret.length < 32) return null;
  return { database, secret, apiKey, from };
}

export function predictionAuth(request: Request, dailyEmailBudgetReserved = false) {
  const settings = readBetterAuthSettings();
  if (!settings) return null;
  const requestOrigin = new URL(request.url).origin;
  const baseURL = requestOrigin.startsWith('http://localhost:')
    ? requestOrigin
    : process.env.RAPPTOR_PUBLIC_SITE_URL?.trim() || requestOrigin;
  return betterAuth({
    baseURL,
    secret: settings.secret,
    database: drizzleAdapter(drizzle(settings.database, { schema }), { provider: 'sqlite', schema }),
    rateLimit: { enabled: true, storage: 'database' },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    plugins: [emailOTP({
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 3,
      storeOTP: 'hashed',
      async sendVerificationOTP({ email, otp, type }) {
        if (type !== 'sign-in') throw new Error('Unsupported verification email.');
        if (!settings.apiKey || !settings.from) throw new Error('Verification email is not configured.');
        const result = await sendRappTorEmail({
          apiKey: settings.apiKey,
          from: settings.from,
          database: settings.database,
          dailyBudgetReserved: dailyEmailBudgetReserved,
        }, {
          to: email,
          ...verificationEmail(otp),
        });
        if (!result.ok && result.status === 429) throw new APIError('TOO_MANY_REQUESTS',
          { code: 'EMAIL_DAILY_LIMIT', message: result.error }, { 'Retry-After': String(result.retryAfter || 60) });
        if (!result.ok) throw new Error('Verification email could not be sent.');
      },
    })],
  });
}

export async function currentPredictionUser(request: Request, responseHeaders?: Headers): Promise<PublicAuthUser | null> {
  const auth = predictionAuth(request);
  if (!auth) return null;
  // Only refresh when the caller can return the renewed cookie to the browser.
  const { response: session, headers } = await auth.api.getSession({
    headers: request.headers,
    returnHeaders: true,
    query: { disableRefresh: !responseHeaders },
  });
  if (responseHeaders) {
    for (const cookie of headers.getSetCookie()) responseHeaders.append('Set-Cookie', cookie);
  }
  if (!session?.user?.emailVerified) return null;
  return { id: session.user.id, email: session.user.email, emailConfirmed: true };
}

export async function requirePredictionAuth(request: Request): Promise<Response | PublicAuthUser> {
  if (!readBetterAuthSettings()) {
    return Response.json({ error: { code: 'AUTH_UNAVAILABLE', message: 'Prediction sign-in is not configured.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const user = await currentPredictionUser(request);
    return user || Response.json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in to use prediction.' } },
      { status: 401, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: { code: 'AUTH_UNAVAILABLE', message: 'Prediction sign-in could not be verified.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
