import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPredictionServerStatus } from '@/features/prediction/service-status';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('public prediction server status', () => {
  it('returns only aggregate queue state', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://docker.test');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      status: 'ready', worker_ready: true, queues: { predict: 2, genome_scan: 3 },
      workload: { running: { predict: { jobs: 1 }, genome_scan: { jobs: 1 } } },
      workers: { predict: true }, model_version: 'secret-detail',
    })));
    expect(await readPredictionServerStatus()).toEqual({
      status: 'busy', waiting: { genomes: 3, shortSequences: 2 }, running: { genomes: 1, shortSequences: 1 },
    });
  });

  it('reports idle and offline without failing the page', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://docker.test');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'ready', worker_ready: true, queues: {}, workload: {} }))
      .mockRejectedValueOnce(new TypeError('network')));
    expect(await readPredictionServerStatus()).toMatchObject({ status: 'idle' });
    expect(await readPredictionServerStatus()).toMatchObject({ status: 'offline' });
  });
});
