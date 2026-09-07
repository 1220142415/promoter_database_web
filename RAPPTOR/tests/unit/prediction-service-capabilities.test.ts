import { afterEach, describe, expect, it, vi } from 'vitest';
import { queuedPredictionCapabilities, queuedPredictionLocalTest } from '@/features/prediction/service-capabilities';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('queued service capability detection', () => {
  it('requires ticket and Turnstile configuration but no email settings in IP mode', async () => {
    const settings = {
      RAPPTOR_PREDICTION_ACCESS_MODE: 'ip',
      RAPPTOR_PREDICTION_SERVICE_URL: 'https://service.test',
      RAPPTOR_PREDICTION_MODEL_VERSION: 'candidate-github-93cf',
      RAPPTOR_PREDICTION_ENABLED: 'on',
      RAPPTOR_PREDICTION_MAX_BASES: '6000000',
      RAPPTOR_PREDICTION_TICKETS_PER_MINUTE: '2',
      RAPPTOR_PREDICTION_BASES_PER_DAY: '12000000',
      RAPPTOR_PREDICTION_TICKET_TTL_SECONDS: '120',
      RAPPTOR_TURNSTILE_SECRET: 'test-turnstile-secret',
      NEXT_PUBLIC_RAPPTOR_TURNSTILE_SITE_KEY: 'test-site-key',
      RAPPTOR_PREDICTION_SERVICE_SECRET: 'test-service-secret',
      RAPPTOR_PREDICTION_IP_HASH_SECRET: 'test-hash-secret',
      SUPABASE_URL: '',
    };
    for (const [key, value] of Object.entries(settings)) vi.stubEnv(key, value);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/readyz') ? { status: 'ready' } : { model_version: 'candidate-github-93cf' })));
    expect(await queuedPredictionCapabilities()).toMatchObject({ available: true, submissionIssue: undefined });
    vi.stubEnv('NEXT_PUBLIC_RAPPTOR_TURNSTILE_SITE_KEY', '');
    expect((await queuedPredictionCapabilities()).submissionIssue).toContain('human verification');
  });
  it('uses the private issuer readiness check instead of email or Turnstile in local mode', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://service.test');
    vi.stubEnv('RAPPTOR_PREDICTION_MODEL_VERSION', 'candidate-github-93cf');
    vi.stubEnv('RAPPTOR_LOCAL_TEST_SECRET', 'a'.repeat(64));
    vi.stubEnv('RAPPTOR_LOCAL_TEST_TICKET_ORIGIN', 'https://tickets.test');
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/prediction-test-tickets') ? { available: true, modelVersion: 'candidate-github-93cf' } : url.endsWith('/readyz') ? { status: 'ready' } : { model_version: 'candidate-github-93cf' })));
    const result = await queuedPredictionCapabilities(true);
    expect(result.available).toBe(true);
    expect(result.submissionIssue).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
  });
  it('explains the missing development key without asking for email setup', async () => {
    vi.stubEnv('RAPPTOR_LOCAL_TEST_SECRET', '');
    const result = await queuedPredictionCapabilities(true);
    expect(result.submissionIssue).toContain('dedicated development key');
    expect(result.submissionIssue).not.toContain('Email');
  });
  it('reports missing authorization configuration even when the model worker is ready', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://service.test');
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_RAPPTOR_TURNSTILE_SITE_KEY', '');
    vi.stubEnv('RAPPTOR_PREDICTION_ENABLED', '');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/readyz') ? { status: 'ready' } : { model_version: 'candidate-github-93cf' })));
    const result = await queuedPredictionCapabilities();
    expect(result.available).toBe(true);
    expect(result.submissionIssue).toContain('Email sign-in, human verification, prediction authorization');
  });
  it('does not enable local-test UI from a public flag alone', () => {
    vi.stubEnv('NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST', 'on');
    vi.stubEnv('RAPPTOR_DEPLOYMENT_ENV', '');
    vi.stubEnv('RAPPTOR_PREDICTION_LOCAL_TEST', '');
    expect(queuedPredictionLocalTest()).toBe(false);
  });
  it('keeps an older ready service usable without sending unsupported cutoff parameters', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://service.test');
    vi.stubEnv('RAPPTOR_PREDICTION_MODEL_VERSION', 'candidate-github-93cf');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/readyz') ? { status: 'ready' } : { model_version: 'candidate-github-93cf', genome_scan: {} })));
    expect(await queuedPredictionCapabilities()).toMatchObject({ available: true, supportsScoreCutoff: false });
  });
  it('reports a service failure instead of offering illustrative predictions', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://service.test');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await queuedPredictionCapabilities()).toMatchObject({ available: false, reason: expect.stringContaining('unavailable') });
  });
  it('rejects an unexpected model identity', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://service.test');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/readyz') ? { status: 'ready' } : { model_version: 'other-model' })));
    expect(await queuedPredictionCapabilities()).toMatchObject({ available: false, reason: expect.stringContaining('does not match') });
  });
});
