import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, HEAD } from '@/app/api/predictions/jobs/[jobId]/artifacts/[filename]/route';

const jobId = 'c'.repeat(32);
const context = { params: Promise.resolve({ jobId, filename: 'model-score-tracks.zip' }) };
const request = (method = 'GET', authenticated = true, range?: string) => new Request('http://localhost/download', {
  method,
  headers: {
    ...(authenticated ? { cookie: `rapptor_job_${jobId}=zip-token` } : {}),
    ...(range ? { range } : {}),
  },
});

beforeEach(() => vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://model.example.test'));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('protected BigWig ZIP download', () => {
  it.each(['GET', 'HEAD'])('proxies Docker\'s pre-generated ZIP for %s', async (method) => {
    const bytes = new Uint8Array([80, 75, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(method === 'HEAD' ? null : bytes, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="model-score-tracks.zip"',
        'Content-Length': String(bytes.length),
        'Accept-Ranges': 'bytes',
        ETag: '"zip-etag"',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = method === 'HEAD' ? await HEAD(request(method), context) : await GET(request(method), context);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toContain('model-score-tracks.zip');
    expect(await response.arrayBuffer()).toEqual(method === 'HEAD' ? new ArrayBuffer(0) : bytes.buffer);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://model.example.test/v1/jobs/${jobId}/artifacts/model-score-tracks.zip`,
      expect.objectContaining({ method, cache: 'no-store' }),
    );
  });

  it('forwards byte ranges and upstream errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 410, headers: { 'Content-Range': 'bytes */4' } }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(request('GET', true, 'bytes=2-3'), context);

    expect(response.status).toBe(410);
    expect(response.headers.get('content-range')).toBe('bytes */4');
    expect(fetchMock.mock.calls[0][1].headers.get('Range')).toBe('bytes=2-3');
  });

  it('rejects missing credentials without contacting Docker', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(request('GET', false), context)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
