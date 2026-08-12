import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

function unauthorized() {
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Basic realm="SeqEdge demo", charset="UTF-8"',
    },
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

export function middleware(request: NextRequest) {
  const expectedUsername = process.env.SEQEDGE_DEMO_USERNAME;
  const expectedPassword = process.env.SEQEDGE_DEMO_PASSWORD;
  if (!expectedUsername || !expectedPassword) return NextResponse.next();

  const credentials = readBasicCredentials(request.headers.get('authorization'));
  if (credentials?.username === expectedUsername && credentials.password === expectedPassword) {
    return NextResponse.next();
  }

  return unauthorized();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
