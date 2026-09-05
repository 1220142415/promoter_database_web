import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ used: false, releases: 0 }));

vi.mock('@/features/auth/supabase', () => ({
  requirePredictionAuth: vi.fn().mockResolvedValue({ id: 'user-1', email: 'person@example.test', emailConfirmed: true }),
}));

vi.mock('@/features/usage/store', () => ({
  usageDatabase: () => ({
    prepare: (sql: string) => ({
      bind: () => ({
        run: async () => {
          let changes = 0;
          if (sql.startsWith('INSERT INTO prediction_daily_quota') && !state.used) {
            state.used = true;
            changes = 1;
          } else if (sql.startsWith('DELETE FROM prediction_daily_quota')) {
            state.used = false;
            state.releases += 1;
            changes = 1;
          }
          return { meta: { changes } };
        },
      }),
    }),
  }),
}));

import { POST } from '@/app/api/predictions/jobs/route';
import { requirePredictionAuth } from '@/features/auth/supabase';

function request(mode: 'predict' | 'genome_scan') {
  return new Request('http://localhost/api/predictions/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Ticket ticket-value' },
    body: JSON.stringify({ mode, sequence: 'A'.repeat(100) }),
  });
}

beforeEach(() => {
  vi.mocked(requirePredictionAuth).mockResolvedValue({ id: 'user-1', email: 'person@example.test', emailConfirmed: true });
  state.used = false;
  state.releases = 0;
  process.env.RAPPTOR_PREDICTION_SERVICE_URL = 'https://prediction.example.test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RAPPTOR_PREDICTION_SERVICE_URL;
});

describe('whole-genome submission quota', () => {
  it('allows one genome scan and leaves short predictions unlimited by the daily quota', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ job_id: 'job-1' }, { status: 202 })));
    const first = await POST(request('genome_scan'));
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(202);
    const limited = await POST(request('genome_scan'));
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: 'DAILY_GENOME_SCAN_LIMIT' } });
    expect((await POST(request('predict'))).status).toBe(202);
    expect((await POST(request('predict'))).status).toBe(202);
  });

  it('returns the quota when the prediction service rejects the job', async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'INVALID_INPUT' } }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ job_id: 'job-2' }, { status: 202 }));
    vi.stubGlobal('fetch', upstream);
    const rejected = await POST(request('genome_scan'));
    expect(rejected.status, JSON.stringify(await rejected.clone().json())).toBe(400);
    expect(state.releases).toBe(1);
    expect((await POST(request('genome_scan'))).status).toBe(202);
  });
});
