import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ usedBases: 0, releases: 0 }));

vi.mock('@/features/email-system/supabase', () => ({
  requirePredictionAuth: vi.fn().mockResolvedValue({ id: 'user-1', email: 'person@example.test', emailConfirmed: true }),
}));

vi.mock('@/features/usage/store', () => ({
  usageDatabase: () => ({
    prepare: (sql: string) => ({
      bind: (...bindings: unknown[]) => ({
        run: async () => {
          let changes = 0;
          if (sql.startsWith('INSERT INTO prediction_daily_quota')) {
            const bases = Number(bindings[2]);
            const maxBases = Number(bindings[4]);
            if (state.usedBases + bases <= maxBases) {
              state.usedBases += bases;
              changes = 1;
            }
          } else if (sql.startsWith('UPDATE prediction_daily_quota')) {
            state.usedBases = Math.max(0, state.usedBases - Number(bindings[0]));
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
import { requirePredictionAuth } from '@/features/email-system/supabase';

function request(mode: 'predict' | 'genome_scan') {
  return new Request('http://localhost/api/predictions/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Ticket ticket-value' },
    body: JSON.stringify(mode === 'predict'
      ? { mode, sequence: 'A'.repeat(100) }
      : { mode, fasta: `>contig\n${'A'.repeat(100)}` }),
  });
}

beforeEach(() => {
  vi.mocked(requirePredictionAuth).mockResolvedValue({ id: 'user-1', email: 'person@example.test', emailConfirmed: true });
  state.usedBases = 0;
  state.releases = 0;
  process.env.RAPPTOR_PREDICTION_SERVICE_URL = 'https://prediction.example.test';
  process.env.RAPPTOR_PREDICTION_GENOME_SCANS_PER_DAY = '5';
  process.env.RAPPTOR_PREDICTION_BASES_PER_DAY = '250';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RAPPTOR_PREDICTION_SERVICE_URL;
  delete process.env.RAPPTOR_PREDICTION_GENOME_SCANS_PER_DAY;
  delete process.env.RAPPTOR_PREDICTION_BASES_PER_DAY;
});

describe('daily prediction-base quota', () => {
  it('counts short and whole-genome predictions against the same allowance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ job_id: 'job-1' }, { status: 202 })));
    expect((await POST(request('predict'))).status).toBe(202);
    expect((await POST(request('genome_scan'))).status).toBe(202);
    expect(state.usedBases).toBe(200);
    const limited = await POST(request('predict'));
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: 'DAILY_BASE_LIMIT' } });
  });

  it('returns the quota when the prediction service rejects the job', async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'INVALID_INPUT' } }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ job_id: 'job-2' }, { status: 202 }));
    vi.stubGlobal('fetch', upstream);
    const rejected = await POST(request('predict'));
    expect(rejected.status, JSON.stringify(await rejected.clone().json())).toBe(400);
    expect(state.releases).toBe(1);
    expect(state.usedBases).toBe(0);
    expect((await POST(request('predict'))).status).toBe(202);
  });
});
