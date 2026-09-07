import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ id: 'user-1', email: 'person@example.test', emailConfirmed: true }));
const callbacks = vi.hoisted(() => [] as Array<() => Promise<void> | void>);
const notification = vi.hoisted(() => ({
  register: vi.fn(),
  send: vi.fn(),
}));
const database = vi.hoisted(() => ({
  prepare: vi.fn(() => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) })),
}));

vi.mock('next/server', () => ({ after: (callback: () => Promise<void> | void) => callbacks.push(callback) }));
vi.mock('@/features/email-system/supabase', () => ({ requirePredictionAuth: vi.fn().mockResolvedValue(auth) }));
vi.mock('@/features/email-system/prediction-notifications', () => ({
  registerPredictionNotification: notification.register,
  sendPredictionNotification: notification.send,
}));
vi.mock('@/features/usage/store', () => ({ usageDatabase: vi.fn() }));

import { POST as createJob } from '@/app/api/predictions/jobs/route';
import { POST as reportJobEvent } from '@/app/api/internal/prediction-jobs/route';
import { requirePredictionAuth } from '@/features/email-system/supabase';

const jobId = '0123456789abcdef0123456789abcdef';

function submissionRequest(mode: 'predict' | 'genome_scan') {
  return new Request('http://localhost/api/predictions/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Ticket valid-ticket' },
    body: JSON.stringify({ mode, sequence: 'A'.repeat(100) }),
  });
}

function eventRequest(status: 'succeeded' | 'failed') {
  return new Request('http://localhost/api/internal/prediction-jobs', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-service-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId,
      status,
      mode: 'predict',
      modelVersion: 'candidate-github-93cf',
      inputBases: 100,
      inputSha256: 'a'.repeat(64),
      submittedAt: '2026-09-05T10:00:00.000Z',
      endedAt: '2026-09-05T10:05:00.000Z',
    }),
  });
}

async function runCallbacks() {
  while (callbacks.length) await callbacks.shift()!();
}

beforeEach(() => {
  callbacks.length = 0;
  vi.mocked(requirePredictionAuth).mockResolvedValue(auth);
  notification.register.mockClear();
  notification.send.mockClear();
  database.prepare.mockClear();
  process.env.RAPPTOR_PREDICTION_SERVICE_URL = 'https://prediction.example.test';
  process.env.RAPPTOR_PREDICTION_ENABLED = 'on';
  process.env.RAPPTOR_PREDICTION_MODEL_VERSION = 'candidate-github-93cf';
  process.env.RAPPTOR_PREDICTION_MAX_BASES = '6000000';
  process.env.RAPPTOR_PREDICTION_TICKETS_PER_MINUTE = '2';
  process.env.RAPPTOR_PREDICTION_BASES_PER_DAY = '12000000';
  process.env.RAPPTOR_PREDICTION_TICKET_TTL_SECONDS = '120';
  process.env.RAPPTOR_TURNSTILE_SECRET = 'test-turnstile-secret';
  process.env.RAPPTOR_PREDICTION_SERVICE_SECRET = 'test-service-secret';
  process.env.RAPPTOR_PREDICTION_IP_HASH_SECRET = 'test-ip-secret';
  process.env.RAPPTOR_PUBLIC_SITE_URL = 'https://rapptor.example.test';
  process.env.RAPPTOR_PREDICTION_ACCESS_MODE = 'email';
});

afterEach(async () => {
  await runCallbacks();
  vi.unstubAllGlobals();
  for (const key of [
    'RAPPTOR_PREDICTION_SERVICE_URL',
    'RAPPTOR_PREDICTION_ENABLED',
    'RAPPTOR_PREDICTION_MODEL_VERSION',
    'RAPPTOR_PREDICTION_MAX_BASES',
    'RAPPTOR_PREDICTION_TICKETS_PER_MINUTE',
    'RAPPTOR_PREDICTION_BASES_PER_DAY',
    'RAPPTOR_PREDICTION_TICKET_TTL_SECONDS',
    'RAPPTOR_TURNSTILE_SECRET',
    'RAPPTOR_PREDICTION_SERVICE_SECRET',
    'RAPPTOR_PREDICTION_IP_HASH_SECRET',
    'RAPPTOR_PUBLIC_SITE_URL',
    'RAPPTOR_PREDICTION_ACCESS_MODE',
  ]) delete process.env[key];
});

describe('prediction job notifications', () => {
  it('registers a queued real job and attempts one completion notification', async () => {
    vi.mocked(database.prepare);
    const { usageDatabase } = await import('@/features/usage/store');
    vi.mocked(usageDatabase).mockReturnValue(database as unknown as D1Database);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ job_id: jobId, access_token: 'a'.repeat(43) }, { status: 202 })));

    const response = await createJob(submissionRequest('predict'));
    await runCallbacks();

    expect(response.status).toBe(202);
    expect(notification.register).toHaveBeenCalledWith(database, jobId, auth, 'predict', {
      token: 'a'.repeat(43),
      tokenSecret: 'test-service-secret',
      referenceName: null,
    }, expect.any(Date));
    expect(notification.send).toHaveBeenCalledWith(database, jobId, {
      apiKey: undefined,
      from: undefined,
      siteUrl: 'https://rapptor.example.test',
      tokenSecret: 'test-service-secret',
    });
  });

  it('keeps short prediction submission working when D1 is unavailable', async () => {
    const { usageDatabase } = await import('@/features/usage/store');
    vi.mocked(usageDatabase).mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ job_id: jobId, access_token: 'a'.repeat(43) }, { status: 202 })));

    const response = await createJob(submissionRequest('predict'));
    await runCallbacks();

    expect(response.status).toBe(202);
    expect(notification.register).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
  });

  it('queues anonymously without Supabase or email notifications in IP mode', async () => {
    process.env.RAPPTOR_PREDICTION_ACCESS_MODE = 'ip';
    vi.mocked(requirePredictionAuth).mockResolvedValue(Response.json({}, { status: 401 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ job_id: jobId, access_token: 'a'.repeat(43) }, { status: 202 })));

    const response = await createJob(submissionRequest('predict'));
    await runCallbacks();

    expect(response.status).toBe(202);
    expect(requirePredictionAuth).not.toHaveBeenCalled();
    expect(notification.register).not.toHaveBeenCalled();
    expect(notification.send).not.toHaveBeenCalled();
  });

  it('passes duplicate terminal callbacks to the storage layer for dedupe', async () => {
    const { usageDatabase } = await import('@/features/usage/store');
    vi.mocked(usageDatabase).mockReturnValue(database as unknown as D1Database);

    for (let index = 0; index < 2; index += 1) {
      const response = await reportJobEvent(eventRequest('succeeded'));
      await runCallbacks();
      expect(response.status).toBe(200);
    }

    expect(notification.send).toHaveBeenCalledTimes(2);
    const settings = { apiKey: undefined, from: undefined, siteUrl: 'https://rapptor.example.test', tokenSecret: 'test-service-secret' };
    expect(notification.send).toHaveBeenNthCalledWith(1, database, jobId, settings);
    expect(notification.send).toHaveBeenNthCalledWith(2, database, jobId, settings);
  });
});
