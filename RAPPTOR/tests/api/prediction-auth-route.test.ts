import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/prediction-auth/route';
import { requirePredictionAuth, withSessionCookie, type AuthSession } from '@/features/auth/supabase';

const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_ANON_KEY;

const session: AuthSession = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  user: { id: 'user-1', email: 'person@example.test', emailConfirmed: true },
};

function request(body?: object, cookie?: string) {
  return new Request('http://localhost/api/prediction-auth', {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function cookieFor(value = session) {
  return withSessionCookie(new Response(), value).headers.get('set-cookie')?.split(';')[0] || '';
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY;
  else process.env.SUPABASE_ANON_KEY = originalKey;
});

describe('prediction authentication', () => {
  it('sends an email OTP and creates the account when needed', async () => {
    const provider = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal('fetch', provider);
    const response = await POST(request({ action: 'send-code', email: 'Person@Example.test' }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ authenticated: false, codeSent: true });
    expect(provider.mock.calls[0]![0]).toContain('/auth/v1/otp');
    expect(JSON.parse(String(provider.mock.calls[0]![1]?.body))).toEqual({ email: 'person@example.test', create_user: true });
  });

  it('creates an HttpOnly session after email code verification', async () => {
    const provider = vi.fn().mockResolvedValue(Response.json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      user: { id: session.user.id, email: session.user.email, email_confirmed_at: '2026-09-05T00:00:00Z' },
    }));
    vi.stubGlobal('fetch', provider);
    const response = await POST(request({ action: 'verify-code', email: 'Person@Example.test', token: '123456' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('rapptor_session=');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    await expect(response.json()).resolves.toMatchObject({ authenticated: true, user: { email: 'person@example.test' } });
    expect(provider.mock.calls[0]![0]).toContain('/auth/v1/verify');
    expect(JSON.parse(String(provider.mock.calls[0]![1]?.body))).toEqual({ type: 'email', email: 'person@example.test', token: '123456' });
  });

  it('refreshes an expired session and rotates the cookie', async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({
        access_token: 'next-access-token',
        refresh_token: 'next-refresh-token',
        user: { id: session.user.id, email: session.user.email, email_confirmed_at: '2026-09-05T00:00:00Z' },
      }));
    vi.stubGlobal('fetch', provider);
    const response = await GET(request(undefined, cookieFor()));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('rapptor_session=');
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[1]![0]).toContain('grant_type=refresh_token');
  });

  it('protects prediction mutation APIs with a confirmed Supabase user', async () => {
    const rejected = await requirePredictionAuth(request());
    expect(rejected).toBeInstanceOf(Response);
    expect(rejected instanceof Response && rejected.status).toBe(401);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      id: session.user.id,
      email: session.user.email,
      email_confirmed_at: '2026-09-05T00:00:00Z',
    })));
    await expect(requirePredictionAuth(request(undefined, cookieFor()))).resolves.toEqual(session.user);
  });
});
