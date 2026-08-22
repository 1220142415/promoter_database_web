import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const keys = ['SEQEDGE_ANALYTICS_USERNAME', 'SEQEDGE_ANALYTICS_PASSWORD', 'SEQEDGE_DEMO_USERNAME', 'SEQEDGE_DEMO_PASSWORD'];
const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function basic(username: string, password: string) {
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

beforeEach(() => {
  for (const key of keys) delete process.env[key];
});

afterEach(() => {
  for (const key of keys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('usage dashboard gate', () => {
  it('hides the dashboard entirely until credentials are configured', () => {
    expect(middleware(new NextRequest('http://localhost/admin/usage')).status).toBe(404);
    expect(middleware(new NextRequest('http://localhost/api/admin/usage')).status).toBe(404);
  });

  it('challenges configured deployments with its own realm', () => {
    process.env.SEQEDGE_ANALYTICS_USERNAME = 'curator';
    process.env.SEQEDGE_ANALYTICS_PASSWORD = 'usage-password';
    const response = middleware(new NextRequest('http://localhost/admin/usage'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('SeqEdge usage');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('admits the configured credentials', () => {
    process.env.SEQEDGE_ANALYTICS_USERNAME = 'curator';
    process.env.SEQEDGE_ANALYTICS_PASSWORD = 'usage-password';
    const response = middleware(new NextRequest('http://localhost/admin/usage', { headers: basic('curator', 'usage-password') }));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('uses the dashboard credentials on admin paths even while the demo gate is active', () => {
    process.env.SEQEDGE_ANALYTICS_USERNAME = 'curator';
    process.env.SEQEDGE_ANALYTICS_PASSWORD = 'usage-password';
    process.env.SEQEDGE_DEMO_USERNAME = 'teacher';
    process.env.SEQEDGE_DEMO_PASSWORD = 'demo-password';

    const dashboard = middleware(new NextRequest('http://localhost/admin/usage', { headers: basic('curator', 'usage-password') }));
    expect(dashboard.headers.get('x-middleware-next')).toBe('1');

    const portal = middleware(new NextRequest('http://localhost/genomes', { headers: basic('teacher', 'demo-password') }));
    expect(portal.headers.get('x-middleware-next')).toBe('1');
  });

  it('does not touch ordinary pages when nothing is configured', () => {
    expect(middleware(new NextRequest('http://localhost/genomes')).headers.get('x-middleware-next')).toBe('1');
  });
});
