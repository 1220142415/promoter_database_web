import 'server-only';

const AUTH_TIMEOUT_MS = 10_000;
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export const AUTH_SESSION_COOKIE = 'rapptor_session';

type SupabaseUser = {
  id?: unknown;
  email?: unknown;
  confirmed_at?: unknown;
  email_confirmed_at?: unknown;
};

type SupabaseSession = {
  access_token?: unknown;
  refresh_token?: unknown;
  user?: SupabaseUser | null;
};

export type AuthSession = {
  access_token: string;
  refresh_token: string;
  user: PublicAuthUser;
};

export type PublicAuthUser = {
  id: string;
  email: string;
  emailConfirmed: boolean;
};

export type AuthSettings = {
  url: string;
  anonKey: string;
};

export function readAuthSettings(): AuthSettings | null {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey || !/^https:\/\//.test(url)) return null;
  return { url, anonKey };
}

export function publicUser(value: unknown): PublicAuthUser | null {
  if (!value || typeof value !== 'object') return null;
  const user = value as SupabaseUser;
  if (typeof user.id !== 'string' || !user.id || typeof user.email !== 'string' || !user.email) return null;
  return {
    id: user.id,
    email: user.email,
    emailConfirmed: Boolean(user.email_confirmed_at || user.confirmed_at),
  };
}

export function parseAuthSession(value: unknown): AuthSession | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as SupabaseSession;
  if (typeof session.access_token !== 'string' || !session.access_token
    || typeof session.refresh_token !== 'string' || !session.refresh_token) return null;
  const user = session.user && publicUser(session.user);
  if (!user) return null;
  return { access_token: session.access_token, refresh_token: session.refresh_token, user };
}

export async function supabaseAuth(
  settings: AuthSettings,
  path: string,
  body: Record<string, unknown>,
  accessToken?: string,
): Promise<{ response: Response; parsed: unknown }> {
  const response = await fetch(`${settings.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: settings.anonKey,
      Authorization: `Bearer ${accessToken || settings.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });
  return { response, parsed: await response.json().catch(() => null) };
}

export async function supabaseUser(
  settings: AuthSettings,
  accessToken: string,
): Promise<{ response: Response; parsed: unknown }> {
  const response = await fetch(`${settings.url}/auth/v1/user`, {
    headers: { apikey: settings.anonKey, Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });
  return { response, parsed: await response.json().catch(() => null) };
}

export function readSessionCookie(request: Request): AuthSession | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  const match = cookie.split(/;\s*/).find((part) => part.startsWith(`${AUTH_SESSION_COOKIE}=`));
  if (!match) return null;
  try {
    return parseAuthSession(JSON.parse(Buffer.from(match.split('=').slice(1).join('='), 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

export function withSessionCookie(response: Response, session: AuthSession): Response {
  const value = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.headers.append(
    'Set-Cookie',
    `${AUTH_SESSION_COOKIE}=${value}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}`,
  );
  return response;
}

export function withClearedSession(response: Response): Response {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.headers.append(
    'Set-Cookie',
    `${AUTH_SESSION_COOKIE}=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0`,
  );
  return response;
}

export async function requirePredictionAuth(request: Request): Promise<Response | PublicAuthUser> {
  const settings = readAuthSettings();
  if (!settings) {
    return Response.json(
      { error: { code: 'AUTH_UNAVAILABLE', message: 'Prediction sign-in is not configured.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const session = readSessionCookie(request);
  if (!session) {
    return Response.json(
      { error: { code: 'AUTH_REQUIRED', message: 'Sign in to use prediction.' } },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  try {
    const result = await supabaseUser(settings, session.access_token);
    const user = result.response.ok ? publicUser(result.parsed) : null;
    if (!user?.emailConfirmed) {
      return Response.json(
        { error: { code: 'AUTH_REQUIRED', message: 'Sign in with a confirmed email to use prediction.' } },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return user;
  } catch {
    return Response.json(
      { error: { code: 'AUTH_UNAVAILABLE', message: 'Prediction sign-in could not be verified.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
