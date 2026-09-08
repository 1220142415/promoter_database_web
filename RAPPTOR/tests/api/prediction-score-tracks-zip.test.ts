import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, HEAD } from '@/app/api/predictions/jobs/[jobId]/artifacts/[filename]/route';

const jobId = 'c'.repeat(32);
const context = { params: Promise.resolve({ jobId, filename: 'model-score-tracks.zip' }) };
const request = (method = 'GET', authenticated = true) => new Request('http://localhost/download', { method, headers: authenticated ? { cookie: `rapptor_job_${jobId}=zip-token` } : {} });
const plus = Buffer.from('123456789');
const minus = Buffer.from([0, 1, 128, 255]);

function mockService(options: { single?: boolean; noTracks?: boolean; status?: string; failedPath?: string; wrongSize?: number; oversize?: boolean; networkFailure?: boolean } = {}) {
  const artifacts = options.noTracks ? [] : [
    { filename: 'scores.plus.bw', size_bytes: options.oversize ? 0xffffffff : options.wrongSize ?? plus.length },
    ...(options.single ? [] : [{ filename: 'scores.minus.bw', size_bytes: minus.length }]),
    { filename: 'input.fasta.fai', size_bytes: 100 }, { filename: 'summary.json', size_bytes: 100 },
  ];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(`/v1/jobs/${jobId}`, '');
    if (path === options.failedPath) return new Response(null, { status: 410 });
    if (!path) return Response.json({ status: options.status || 'succeeded', result: { artifacts } });
    if (options.networkFailure && path.endsWith('scores.minus.bw')) throw new Error('network failure');
    if (path.endsWith('scores.plus.bw')) return new Response(init?.method === 'HEAD' ? null : plus);
    if (path.endsWith('scores.minus.bw')) return new Response(init?.method === 'HEAD' ? null : minus);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Inspect the central directory using standard ZIP offsets, independently of the writer. */
function entries(zip: Buffer) {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let position = zip.readUInt32LE(end + 16);
  const files = [];
  for (let index = 0; index < count; index++) {
    expect(zip.readUInt32LE(position)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(position + 28);
    const size = zip.readUInt32LE(position + 24);
    const local = zip.readUInt32LE(position + 42);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    expect(zip.readUInt16LE(local + 8)).toBe(0); // Stored BigWig bytes.
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    files.push({ name: zip.subarray(position + 46, position + 46 + nameLength).toString(), data: zip.subarray(dataStart, dataStart + size), crc: zip.readUInt32LE(position + 16) });
    position += 46 + nameLength + zip.readUInt16LE(position + 30) + zip.readUInt16LE(position + 32);
  }
  expect(position).toBe(end);
  return files;
}

beforeEach(() => vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://model.example.test'));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('protected BigWig ZIP download', () => {
  it('packs both strands into one folder with exact bytes and a standard CRC-32', async () => {
    const mock = mockService();
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toContain('model-score-tracks.zip');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBe(Number(response.headers.get('content-length')));
    const files = entries(bytes);
    expect(files.map((file) => file.name)).toEqual(['model-score-tracks/scores.plus.bw', 'model-score-tracks/scores.minus.bw']);
    expect(files[0].data).toEqual(plus);
    expect(files[1].data).toEqual(minus);
    expect(files[0].crc).toBe(0xcbf43926); // Published CRC-32 check vector: 123456789.
    expect(mock.mock.calls.every(([, init]) => (init?.headers as Record<string, string>)['X-Job-Token'] === 'zip-token')).toBe(true);
    expect(mock.mock.calls).toHaveLength(3);
  });

  it('supports a legitimate single-strand task', async () => {
    mockService({ single: true });
    const response = await GET(request(), context);
    expect(entries(Buffer.from(await response.arrayBuffer())).map((file) => file.name)).toEqual(['model-score-tracks/scores.plus.bw']);
  });

  it('supports HEAD without fetching track bodies', async () => {
    const mock = mockService();
    const response = await HEAD(request('HEAD'), context);
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(plus.length + minus.length);
    expect(await response.text()).toBe('');
    expect(mock.mock.calls.slice(1).every(([, init]) => init?.method === 'HEAD')).toBe(true);
    expect(response.headers.get('accept-ranges')).toBeNull();
  });

  it('rejects missing credentials without contacting the service', async () => {
    const mock = mockService();
    expect((await GET(request('GET', false), context)).status).toBe(404);
    expect(mock).not.toHaveBeenCalled();
  });

  it.each(['', '/artifacts/scores.plus.bw', '/artifacts/scores.minus.bw'])('does not create a partial ZIP when access has expired at %s', async (failedPath) => {
    mockService({ failedPath });
    const response = await GET(request(), context);
    expect(response.status).toBe(410);
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('does not create a partial ZIP when a strand request fails', async () => {
    mockService({ networkFailure: true });
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it.each([2, 200])('terminates an incomplete or oversized track stream (declared size %i)', async (wrongSize) => {
    mockService({ wrongSize });
    const response = await GET(request(), context);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it('rejects an unsupported archive size before starting any artifact downloads', async () => {
    const mock = mockService({ oversize: true });
    expect((await GET(request(), context)).status).toBe(413);
    expect(mock.mock.calls).toHaveLength(1);
  });

  it('does not produce an empty ZIP for tasks with no tracks', async () => {
    mockService({ noTracks: true });
    expect((await GET(request(), context)).status).toBe(404);
  });

  it('does not expose files before a task has completed', async () => {
    mockService({ status: 'running' });
    expect((await GET(request(), context)).status).toBe(409);
  });
});
