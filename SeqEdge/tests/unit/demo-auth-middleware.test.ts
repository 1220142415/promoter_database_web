import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const originalUsername = process.env.SEQEDGE_DEMO_USERNAME;
const originalPassword = process.env.SEQEDGE_DEMO_PASSWORD;

describe('temporary demo authentication', () => {
  beforeEach(() => {
    process.env.SEQEDGE_DEMO_USERNAME = 'teacher';
    process.env.SEQEDGE_DEMO_PASSWORD = 'temporary-password';
  });

  afterEach(() => {
    if (originalUsername === undefined) delete process.env.SEQEDGE_DEMO_USERNAME;
    else process.env.SEQEDGE_DEMO_USERNAME = originalUsername;
    if (originalPassword === undefined) delete process.env.SEQEDGE_DEMO_PASSWORD;
    else process.env.SEQEDGE_DEMO_PASSWORD = originalPassword;
  });

  it('does not protect ordinary development when credentials are not configured', () => {
    delete process.env.SEQEDGE_DEMO_USERNAME;
    delete process.env.SEQEDGE_DEMO_PASSWORD;
    const response = middleware(new NextRequest('http://localhost/genomes'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('challenges requests without valid credentials', () => {
    const response = middleware(new NextRequest('http://localhost/genomes'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('SeqEdge demo');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('allows the configured username and password', () => {
    const authorization = `Basic ${Buffer.from('teacher:temporary-password').toString('base64')}`;
    const response = middleware(new NextRequest('http://localhost/genomes', { headers: { authorization } }));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
