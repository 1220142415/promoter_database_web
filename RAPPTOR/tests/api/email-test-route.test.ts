import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/internal/email-test/route';

const keys = ['RESEND_API_KEY', 'RESEND_TEST_TO', 'RESEND_FROM', 'RAPPTOR_EMAIL_TEST_TOKEN'] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function request(token = 'test-route-token') {
  return new Request('http://localhost/api/internal/email-test', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  Object.assign(process.env, {
    RESEND_API_KEY: 're_test_key',
    RESEND_TEST_TO: 'recipient@example.test',
    RAPPTOR_EMAIL_TEST_TOKEN: 'test-route-token',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe('POST /api/internal/email-test', () => {
  it('sends one fixed test message and returns only a masked message ID', async () => {
    const provider = vi.fn().mockResolvedValue(Response.json({ id: '12345678-1234-5678-9012-123456789abc' }));
    vi.stubGlobal('fetch', provider);

    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ accepted: true, messageId: '12345678…9abc' });
    expect(provider).toHaveBeenCalledTimes(1);
    const [, init] = provider.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(init.body)).toMatchObject({
      from: 'RAPPtor <no-reply@auth.email.duolalab.qzz.io>',
      to: ['recipient@example.test'],
    });
  });

  it('rejects an invalid route token without contacting Resend', async () => {
    const provider = vi.fn();
    vi.stubGlobal('fetch', provider);
    expect((await POST(request('wrong-token'))).status).toBe(401);
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not retry provider failures or expose their response body', async () => {
    const provider = vi.fn().mockResolvedValue(Response.json({ message: 'sensitive provider detail' }, { status: 429 }));
    vi.stubGlobal('fetch', provider);
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ accepted: false, providerStatus: 429 });
  });
});
