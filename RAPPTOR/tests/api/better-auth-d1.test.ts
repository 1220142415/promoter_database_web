import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { GET, POST } from '@/app/api/prediction-auth/route';

const state = vi.hoisted(() => ({ database: null as D1Database | null, code: '' }));
vi.mock('@/features/usage/store', () => ({ usageDatabase: () => state.database }));
vi.mock('@/features/prediction/tickets', () => ({ readPredictionBaseUsage: async () => ({ usedBases: 0 }) }));
vi.mock('@/features/email-system/resend', () => ({
  sendRappTorEmail: async (_settings: unknown, message: { text: string }) => {
    state.code = message.text.match(/\b\d{6}\b/)?.[0] || '';
    return { ok: true, messageId: 'local-test' };
  },
}));

let runtime: Miniflare;
const origin = 'https://rapptor.xulab.science';
const email = 'person@example.test';

function request(body?: object, cookie?: string) {
  return new Request(`${origin}/api/prediction-auth`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Origin: origin,
      'cf-connecting-ip': '203.0.113.24',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  vi.stubEnv('BETTER_AUTH_SECRET', 'local-test-secret-that-is-at-least-32-characters');
  vi.stubEnv('RESEND_API_KEY', 'local-test-only');
  vi.stubEnv('RESEND_FROM', 'RAPPTOR <sign-in@example.test>');
  vi.stubEnv('RAPPTOR_PUBLIC_SITE_URL', origin);
  vi.stubEnv('RAPPTOR_PREDICTION_ACCESS_MODE', 'email');
  runtime = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'auth-test',
      modules: true,
      script: 'export default { fetch() { return new Response("local auth test"); } };',
      compatibilityDate: '2026-08-13',
      d1Databases: ['DB'],
    }],
  }));
  state.database = await runtime.getD1Database('DB', 'auth-test') as unknown as D1Database;
  for (const file of ['0012_prediction_job_notifications.sql', '0013_prediction_notification_links.sql',
    '0018_better_auth.sql', '0019_auth_email_reliability.sql']) {
    const migration = readFileSync(`database/migrations/${file}`, 'utf8');
    for (const sql of migration.split(';').filter((value) => value.trim())) await state.database.prepare(sql).run();
  }
  await state.database.prepare('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .bind('retained-user-id', '', email, 1, Date.now(), Date.now()).run();
}, 30_000);

afterAll(async () => {
  await runtime?.dispose();
  vi.unstubAllEnvs();
});

describe('Better Auth on D1', () => {
  it('verifies a new code, preserves the migrated user ID and creates a usable secure session', async () => {
    const sent = await POST(request({ action: 'send-code', email }));
    expect(sent.status).toBe(202);
    expect(state.code).toMatch(/^\d{6}$/);
    const verified = await POST(request({ action: 'verify-code', email, token: state.code }));
    expect(await verified.clone().json()).toMatchObject({ authenticated: true, user: { id: 'retained-user-id', email } });
    expect(verified.status).toBe(200);
    const cookies = verified.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.includes('__Secure-better-auth.session_token=') && cookie.includes('HttpOnly') && cookie.includes('Secure'))).toBe(true);
    const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    expect(await (await GET(request(undefined, cookie))).json()).toMatchObject({ authenticated: true });
    // Existing sessions can retry navigation without reusing a one-time code.
    expect(await (await POST(request({ action: 'verify-code', email, token: state.code }, cookie))).json())
      .toMatchObject({ authenticated: true, user: { id: 'retained-user-id' } });
    expect((await POST(request({ action: 'verify-code', email: 'other@example.test', token: state.code }, cookie))).status).toBe(401);
    expect((await POST(request({ action: 'verify-code', email, token: state.code }))).status).toBe(401);
    const rateLimited = await POST(request({ action: 'verify-code', email, token: state.code }));
    expect(rateLimited.status).toBe(429);
    expect(await rateLimited.json()).toMatchObject({ error: { code: 'AUTH_RATE_LIMITED' } });
  }, 30_000);
});
