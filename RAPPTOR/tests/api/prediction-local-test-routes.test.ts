import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ bindings: [] as unknown[][], changes: 1, dbAvailable: true }));
vi.mock('@/features/usage/store', () => ({ usageDatabase: vi.fn(() => state.dbAvailable ? {
  prepare: () => ({
    all: async () => ({ results: [] }),
    bind: (...values: unknown[]) => { state.bindings.push(values); return { run: async () => ({ meta: { changes: state.changes } }) }; },
  }),
} : null) }));
vi.mock('@/features/email-system/supabase', () => ({ requirePredictionAuth: vi.fn(async () => Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })) }));
vi.mock('@/features/email-system/prediction-notifications', () => ({ registerPredictionNotification: vi.fn(), sendPredictionNotification: vi.fn() }));
import { GET as ready, POST as issue } from '@/app/api/internal/prediction-test-tickets/route';
import { POST as localTicket } from '@/app/api/prediction-tickets/route';
import { POST as job } from '@/app/api/predictions/jobs/route';
import { requirePredictionAuth } from '@/features/email-system/supabase';
import { registerPredictionNotification, sendPredictionNotification } from '@/features/email-system/prediction-notifications';
import { usageDatabase } from '@/features/usage/store';

const secret = 'a'.repeat(64);
const input = { modelVersion: 'candidate-github-93cf', mode: 'genome_scan', bases: 4_641_652 };
function request(path: string, body: unknown = input, extra: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:3000${path}`, { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
}
const remote = (body: unknown = input, authorization = `Bearer ${secret}`) => request('/api/internal/prediction-test-tickets', body, { authorization });
beforeEach(() => {
  state.bindings = []; state.changes = 1; state.dbAvailable = true;
  for (const [name, value] of Object.entries({
    NODE_ENV: 'development', RAPPTOR_DEPLOYMENT_ENV: 'local', RAPPTOR_PREDICTION_LOCAL_TEST: 'on', NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST: 'on',
    RAPPTOR_LOCAL_TEST_ORIGIN: 'http://127.0.0.1:3000', RAPPTOR_LOCAL_TEST_TICKET_ORIGIN: 'https://tickets.example.test', RAPPTOR_LOCAL_TEST_SECRET: secret,
    RAPPTOR_PREDICTION_ENABLED: 'on', RAPPTOR_PREDICTION_MODEL_VERSION: input.modelVersion, RAPPTOR_PREDICTION_MAX_BASES: '6000000',
    RAPPTOR_PREDICTION_TICKETS_PER_MINUTE: '2', RAPPTOR_PREDICTION_GENOME_SCANS_PER_DAY: '5', RAPPTOR_PREDICTION_BASES_PER_DAY: '12000000', RAPPTOR_PREDICTION_TICKET_TTL_SECONDS: '120',
    RAPPTOR_PREDICTION_IP_HASH_SECRET: 'test-hash-secret', RAPPTOR_PREDICTION_SERVICE_URL: 'https://service.example.test',
  })) vi.stubEnv(name, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('protected remote development issuer', () => {
  it('issues a genuine hashed D1 ticket in production using the dedicated key', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RAPPTOR_DEPLOYMENT_ENV', 'production');
    const response = await issue(remote());
    const result = await response.json() as { ticket: string };
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(result).toMatchObject({ modelVersion: input.modelVersion, maxBases: input.bases });
    expect(result.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state.bindings[0][0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(state.bindings)).not.toContain(result.ticket);
    expect(JSON.stringify(state.bindings)).not.toContain(secret);
    expect(requirePredictionAuth).not.toHaveBeenCalled();
  });
  it('probes configuration without issuing a ticket', async () => {
    expect((await ready(remote())).status).toBe(200);
    expect(state.bindings).toHaveLength(0);
  });
  it.each(['', 'Bearer wrong', `Ticket ${secret}`])('rejects missing or wrong authorization before D1 access', async (authorization) => {
    expect((await issue(remote(input, authorization))).status).toBe(401);
    expect(usageDatabase).not.toHaveBeenCalled();
  });
  it('disables the endpoint after secret removal and refuses service-key reuse', async () => {
    vi.stubEnv('RAPPTOR_LOCAL_TEST_SECRET', '');
    expect((await issue(remote())).status).toBe(404);
    vi.stubEnv('RAPPTOR_LOCAL_TEST_SECRET', secret);
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_SECRET', secret);
    expect((await issue(remote())).status).toBe(404);
    expect(usageDatabase).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...input, bases: 6_000_001 }, 413], [{ ...input, bases: -1 }, 400],
    [{ ...input, modelVersion: 'other' }, 400], [null, 400], [{ ...input, mode: 'invalid' }, 400],
  ])('rejects invalid model/input %j', async (body, status) => {
    expect((await issue(remote(body))).status).toBe(status);
    expect(state.bindings).toHaveLength(0);
  });
  it('retains D1 rate limits and reports database outages', async () => {
    state.changes = 0;
    expect((await issue(remote())).status).toBe(429);
    state.dbAvailable = false;
    expect((await issue(remote())).status).toBe(503);
  });
});

describe('local ticket relay and job creation', () => {
  it('relays the real ticket without returning the development key', async () => {
    const issued = { ticket: 'c'.repeat(43), modelVersion: input.modelVersion, maxBases: input.bases, expiresAt: new Date(Date.now() + 120_000).toISOString() };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(issued)));
    const response = await localTicket(request('/api/prediction-tickets'));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject(issued);
    expect(requirePredictionAuth).not.toHaveBeenCalled();
  });
  it('keeps job tokens and skips user creation, quota reservations and notifications for local tests', async () => {
    const created = { job_id: 'b'.repeat(32), access_token: 'protected-job-token' };
    const upstream = vi.fn().mockResolvedValue(Response.json(created, { status: 202 }));
    vi.stubGlobal('fetch', upstream);
    const response = await job(request('/api/predictions/jobs', { mode: 'genome_scan', fasta: '>public-test\nACGT' }, { authorization: 'Ticket real-ticket' }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(created);
    expect(requirePredictionAuth).not.toHaveBeenCalled();
    expect(usageDatabase).not.toHaveBeenCalled();
    expect(registerPredictionNotification).not.toHaveBeenCalled();
    expect(sendPredictionNotification).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledWith('https://service.example.test/v1/jobs', expect.objectContaining({ headers: { 'Content-Type': 'application/json', Authorization: 'Ticket real-ticket' } }));
  });
  it('preserves model-service ticket rejection instead of fabricating a task', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'INVALID_TICKET' } }, { status: 401 })));
    expect((await job(request('/api/predictions/jobs', { mode: 'predict' }, { authorization: 'Ticket expired' }))).status).toBe(401);
  });
  it('requires a development key and a real ticket even in local mode', async () => {
    expect((await job(request('/api/predictions/jobs'))).status).toBe(401);
    vi.stubEnv('RAPPTOR_LOCAL_TEST_SECRET', '');
    expect((await localTicket(request('/api/prediction-tickets'))).status).toBe(503);
    expect((await job(request('/api/predictions/jobs'))).status).toBe(503);
  });
  it.each(['production', 'nonlocal', 'cross-origin'])('keeps formal authentication for %s requests', async (kind) => {
    if (kind === 'production') vi.stubEnv('NODE_ENV', 'production');
    const extra: Record<string, string> = kind === 'nonlocal' ? { host: 'remote.example.test' } : kind === 'cross-origin' ? { origin: 'https://evil.example.test' } : {};
    expect((await localTicket(request('/api/prediction-tickets', input, extra))).status).toBe(401);
    expect((await job(request('/api/predictions/jobs', { mode: 'predict' }, extra))).status).toBe(401);
    expect(requirePredictionAuth).toHaveBeenCalledTimes(2);
  });
  it('does not exempt the legacy versioned provider API from authentication', async () => {
    expect((await localTicket(request('/api/prediction-tickets', { contractVersion: 'legacy', mode: 'predict' }))).status).toBe(401);
    expect(requirePredictionAuth).toHaveBeenCalledOnce();
  });
});
