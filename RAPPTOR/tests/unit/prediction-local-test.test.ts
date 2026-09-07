import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localPredictionTestEnabled, requestLocalPredictionTicket } from '@/features/prediction/local-test';

const secret = 'a'.repeat(64);
const url = 'http://127.0.0.1:3000/api/prediction-tickets';
const input = { mode: 'predict' as const, modelVersion: 'candidate-github-93cf', bases: 4_641_752 };
const headers = (extra: Record<string, string> = {}) => new Headers({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...extra });
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('RAPPTOR_DEPLOYMENT_ENV', 'local');
  vi.stubEnv('RAPPTOR_PREDICTION_LOCAL_TEST', 'on');
  vi.stubEnv('NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST', 'on');
  vi.stubEnv('RAPPTOR_LOCAL_TEST_ORIGIN', 'http://127.0.0.1:3000');
  vi.stubEnv('RAPPTOR_LOCAL_TEST_TICKET_ORIGIN', 'https://tickets.example.test');
  vi.stubEnv('RAPPTOR_LOCAL_TEST_SECRET', secret);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('local prediction request boundary', () => {
  it('accepts a same-origin request on the explicitly configured loopback port', () => {
    expect(localPredictionTestEnabled(headers(), url, true)).toBe(true);
    expect(localPredictionTestEnabled(headers({ 'x-forwarded-for': '::ffff:127.0.0.1', 'x-forwarded-host': '127.0.0.1:3000', 'x-forwarded-proto': 'http' }), url, true)).toBe(true);
    expect(localPredictionTestEnabled(new Headers({ host: 'localhost:3000' }))).toBe(true);
    expect(localPredictionTestEnabled(headers(), 'http://localhost:3000/api/prediction-tickets', true)).toBe(true);
  });
  it.each([
    ['NODE_ENV', 'production'], ['NODE_ENV', 'test'], ['RAPPTOR_DEPLOYMENT_ENV', 'production'],
    ['RAPPTOR_PREDICTION_LOCAL_TEST', 'off'], ['NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST', 'off'],
    ['RAPPTOR_LOCAL_TEST_ORIGIN', ''], ['RAPPTOR_LOCAL_TEST_ORIGIN', 'http://0.0.0.0:3000'],
  ])('rejects an unsafe or incomplete setting: %s=%s', (name, value) => {
    vi.stubEnv(name, value);
    expect(localPredictionTestEnabled(headers(), url, true)).toBe(false);
  });
  it.each<Record<string, string>>([
    { host: 'public.example.test:3000' }, { host: '127.0.0.1:3001' }, { host: 'evil@127.0.0.1:3000' },
    { origin: 'https://evil.example.test' }, { origin: 'null' }, { origin: '' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { 'x-forwarded-for': '203.0.113.10' }, { 'x-forwarded-host': 'public.example.test' },
    { 'x-forwarded-proto': 'https' }, { 'forwarded': 'for=127.0.0.1' }, { 'cf-connecting-ip': '127.0.0.1' },
  ])('rejects nonlocal or spoofed request headers: %j', (extra) => {
    expect(localPredictionTestEnabled(headers(extra), url, true)).toBe(false);
  });
  it('does not trust a loopback Host when the request URL is remote', () => {
    expect(localPredictionTestEnabled(headers(), 'https://public.example.test/api/prediction-tickets', true)).toBe(false);
  });
});

describe('private remote ticket client', () => {
  it('requests a real bounded ticket server to server without forwarding human verification or user identity', async () => {
    const issued = { ticket: 'b'.repeat(43), modelVersion: input.modelVersion, maxBases: input.bases, expiresAt: new Date(Date.now() + 120_000).toISOString(), inputRequirements: { completeGenomeRequired: true, conditioning: 'CGR_128x128' } };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ...issued, privateDebug: secret }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await requestLocalPredictionTicket(input)).toEqual(issued);
    expect(fetchMock).toHaveBeenCalledWith('https://tickets.example.test/api/internal/prediction-test-tickets', expect.objectContaining({
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input), redirect: 'error',
    }));
  });
  it.each(['', 'short-key'])('fails before fetching when the key is absent or malformed', async (value) => {
    vi.stubEnv('RAPPTOR_LOCAL_TEST_SECRET', value);
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(requestLocalPredictionTicket(input)).rejects.toThrow('dedicated development key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('refuses to reuse the service key', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_SECRET', secret);
    await expect(requestLocalPredictionTicket(input)).rejects.toThrow('separate');
  });
  it.each([401, 404, 413, 429, 503])('reports HTTP %s without reflecting credentials in upstream errors', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: secret } }, { status })));
    await expect(requestLocalPredictionTicket(input)).rejects.toMatchObject({ status });
    try { await requestLocalPredictionTicket(input); } catch (cause) { expect((cause as Error).message).not.toContain(secret); }
  });
  it.each(['local-fake', 'b'.repeat(43)])('rejects fake or expired tickets', async (ticket) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ticket, modelVersion: input.modelVersion, maxBases: input.bases, expiresAt: '2020-01-01T00:00:00Z' })));
    await expect(requestLocalPredictionTicket(input)).rejects.toThrow('invalid or expired');
  });
});
