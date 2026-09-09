import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/predictions/jobs/[jobId]/route';

const jobId = '8242cc4cdaae4f07ab082dad6e3238fe';
const context = { params: Promise.resolve({ jobId }) };
const request = () => new Request(`https://site.test/api/predictions/jobs/${jobId}`, { headers: { 'X-Job-Token': 'test-token' } });

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('job status proxy', () => {
  it('passes through Docker queue and ETA data with one authenticated request', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://service.test');
    const job = { status: 'queued', mode: 'genome_scan', queue: {
      ahead: 0, waiting: 1, estimated_wait_seconds: 125, running: 1, worker_ready: true,
    } };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(job));
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(request(), context);
    expect(await response.json()).toEqual(job);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`https://service.test/v1/jobs/${jobId}`, {
      headers: { 'X-Job-Token': 'test-token' }, cache: 'no-store',
    });
  });

  it.each(['running', 'succeeded', 'failed'])('does not fetch extra load for a %s job', async (status) => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://service.test');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(request(), context)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fetch load or expose job details after an authorization failure', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://service.test');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: 'not found' }, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(request(), context)).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
