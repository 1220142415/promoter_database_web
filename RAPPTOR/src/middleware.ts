import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { scheduleUsageCollection } from '@/features/usage/store';

const ADMIN_PREFIXES = ['/admin', '/api/admin'];

function unauthorized(realm: string) {
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`,
    },
  });
}

function notFound() {
  return new NextResponse('Not found.', {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function readBasicCredentials(header: string | null) {
  if (!header?.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function matches(header: string | null, expectedUsername: string, expectedPassword: string) {
  const credentials = readBasicCredentials(header);
  return credentials?.username === expectedUsername && credentials.password === expectedPassword;
}

function demoGate(request: NextRequest) {
  const expectedUsername = process.env.RAPPTOR_DEMO_USERNAME;
  const expectedPassword = process.env.RAPPTOR_DEMO_PASSWORD;
  if (!expectedUsername || !expectedPassword) return null;
  return matches(request.headers.get('authorization'), expectedUsername, expectedPassword)
    ? null
    : unauthorized('RAPPTOR demo');
}

/**
 * The usage dashboard stays invisible until both credentials are configured, so
 * an ordinary deployment answers 404 for every admin path. Admin paths use their
 * own credentials instead of the demo ones: a request carries a single
 * Authorization header and cannot satisfy both realms at once.
 */
function adminGate(request: NextRequest) {
  const expectedUsername = process.env.RAPPTOR_ANALYTICS_USERNAME;
  const expectedPassword = process.env.RAPPTOR_ANALYTICS_PASSWORD;
  if (!expectedUsername || !expectedPassword) return notFound();
  return matches(request.headers.get('authorization'), expectedUsername, expectedPassword)
    ? null
    : unauthorized('RAPPTOR usage');
}

function isAdminPath(pathname: string) {
  return ADMIN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function middleware(request: NextRequest) {
  const blocked = isAdminPath(request.nextUrl.pathname) ? adminGate(request) : demoGate(request);
  if (blocked) return blocked;

  try {
    scheduleUsageCollection(request);
  } catch {
    // Usage counting must never affect the response.
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
