import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ bindings: [] as unknown[] }));
const database = vi.hoisted(() => ({
  prepare: vi.fn(() => ({
    bind: (...values: unknown[]) => {
      state.bindings = values;
      return { run: async () => ({ meta: { changes: 1 } }) };
    },
  })),
}));

vi.mock('@/features/usage/store', () => ({ usageDatabase: () => database }));
vi.mock('@/features/email-system/supabase', () => ({ requirePredictionAuth: vi.fn().mockResolvedValue(Response.json({}, { status: 401 })) }));

import { POST } from '@/app/api/prediction-tickets/route';
import { requirePredictionAuth } from '@/features/email-system/supabase';

const keys = [
  'RAPPTOR_PREDICTION_ACCESS_MODE', 'RAPPTOR_PREDICTION_ENABLED', 'RAPPTOR_PREDICTION_MODEL_VERSION',
  'RAPPTOR_PREDICTION_MAX_BASES', 'RAPPTOR_PREDICTION_TICKETS_PER_MINUTE',
  'RAPPTOR_PREDICTION_BASES_PER_DAY', 'RAPPTOR_PREDICTION_TICKET_TTL_SECONDS',
  'RAPPTOR_TURNSTILE_SECRET', 'RAPPTOR_PREDICTION_SERVICE_SECRET', 'RAPPTOR_PREDICTION_IP_HASH_SECRET',
] as const;

beforeEach(() => {
  Object.assign(process.env, {
    RAPPTOR_PREDICTION_ACCESS_MODE: 'ip',
    RAPPTOR_PREDICTION_ENABLED: 'on',
    RAPPTOR_PREDICTION_MODEL_VERSION: 'candidate-github-93cf',
    RAPPTOR_PREDICTION_MAX_BASES: '6000000',
    RAPPTOR_PREDICTION_TICKETS_PER_MINUTE: '2',
    RAPPTOR_PREDICTION_BASES_PER_DAY: '12000000',
    RAPPTOR_PREDICTION_TICKET_TTL_SECONDS: '120',
    RAPPTOR_TURNSTILE_SECRET: 'turnstile-secret',
    RAPPTOR_PREDICTION_SERVICE_SECRET: 'service-secret',
    RAPPTOR_PREDICTION_IP_HASH_SECRET: 'ip-hash-secret',
  });
  state.bindings = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of keys) delete process.env[key];
});

describe('anonymous IP prediction access', () => {
  it('uses Turnstile and a hashed address without calling Supabase', async () => {
    const provider = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal('fetch', provider);
    const response = await POST(new Request('https://rapptor.example.test/api/prediction-tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.8' },
      body: JSON.stringify({ mode: 'genome_scan', turnstileToken: 'verified-token', modelVersion: 'candidate-github-93cf', bases: 1000 }),
    }));

    expect(response.status).toBe(201);
    expect(requirePredictionAuth).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(String(provider.mock.calls[0]![0])).toContain('challenges.cloudflare.com/turnstile');
    expect(state.bindings).toContain(1);
    expect(JSON.stringify(state.bindings)).not.toContain('203.0.113.8');
  });
});
