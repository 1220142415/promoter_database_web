import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, HEAD } from '@/app/api/predictions/jobs/[jobId]/artifacts/[filename]/route';
import { RESULT_TABLE_HEADER, resultTableStream } from '@/features/prediction/result-table';

const jobId = 'a'.repeat(32);
const context = (filename = 'prediction-results.tsv') => ({ params: Promise.resolve({ jobId, filename }) });
const request = (headers: HeadersInit = { cookie: `rapptor_job_${jobId}=job-secret` }, method = 'GET') => new Request('http://localhost/result', { headers, method });
const gff = '##gff-version 3\nchr1\tRAPPtor\tpromoter_candidate\t81\t81\t0.90000000\t+\t.\twindow_start_0based=0\nchr1\tRAPPtor\tpromoter_candidate\t220\t220\t0.95000000\t-\t.\twindow_start_0based=0\nchr2\tRAPPtor\tpromoter_candidate\t20\t20\t0.96000000\t-\t.\twindow_start_0based=100\n';

function mockService(options: { source?: string; mode?: string; summary?: object | null; fai?: string | null; text?: string; failedPath?: string; status?: number } = {}) {
  const source = options.source ?? 'scores.gff3';
  const summary = options.summary === undefined ? { mode: options.mode ?? 'genome_scan', sequence_bases: 300, model: { seq_length: 100 }, score_cutoff: .9 } : options.summary;
  const fai = options.fai === undefined ? 'chr1\t300\t6\t60\t61\nchr2\t200\t6\t60\t61\n' : options.fai;
  const artifacts = [source, ...(summary ? ['summary.json'] : []), ...(fai ? ['input.fasta.fai'] : [])].map((filename) => ({ filename }));
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(`/v1/jobs/${jobId}`, '');
    if (options.failedPath === path) return new Response(null, { status: options.status || 410 });
    if (!path) return Response.json({ status: 'succeeded', result: { artifacts } });
    if (path === '/artifacts/summary.json') return Response.json(summary);
    if (path === '/artifacts/input.fasta.fai') return new Response(fai);
    if (path === `/artifacts/${source}`) return new Response(init?.method === 'HEAD' ? null : options.text ?? gff);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://model.example.test'));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('protected derived result table', () => {
  it.each(['summary', 'header', 'first-peak-release'])('honors new reference-oriented window coordinates from %s', async (marker) => {
    mockService({
      summary: { model: { seq_length: 100 }, ...(marker === 'summary' ? { window_start_coordinate_system: 'reference_0based' } : marker === 'first-peak-release' ? { smoothing: { method: 'gaussian', sigma: 1, mode: 'reflect' }, peak_calling: { distance: 10, cutoff: .9, operator: '>' } } : {}) },
      text: '##gff-version 3\n' + (marker === 'header' ? '##RAPPtor-window-start-coordinate-system reference_0based\n' : '')
        + 'chr1\tRAPPtor\tpromoter_candidate\t220\t220\t0.95000000\t-\t.\twindow_start_0based=200\n',
    });
    expect(await (await GET(request(), context())).text()).toBe(RESULT_TABLE_HEADER + 'chr1\t201\t300\t220\t-\t0.95000000\n');
  });
  it('converts both strands and multiple contigs without filtering a rounded cutoff score again', async () => {
    const mock = mockService();
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('prediction-results.tsv');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe(RESULT_TABLE_HEADER + 'chr1\t1\t100\t81\t+\t0.90000000\nchr1\t201\t300\t220\t-\t0.95000000\nchr2\t1\t100\t20\t-\t0.96000000\n');
    expect(mock.mock.calls.every(([, init]) => (init?.headers as Record<string, string>)['X-Job-Token'] === 'job-secret')).toBe(true);
    expect(mock.mock.calls.some(([url]) => String(url).includes('prediction-results.tsv'))).toBe(false);
  });

  it('exports all returned short-sequence rows in their original order, including duplicates and a legacy single strand', async () => {
    const rows = [{ sequence_id: 'target_sequence', window_start_0based: 20, anchor_position_0based: 259, strand: '-', score: .123456789 },
      { sequence_id: 'target_sequence', window_start_0based: 20, anchor_position_0based: 259, strand: '-', score: .123456789 }];
    mockService({ source: 'scores.json', mode: 'predict', text: JSON.stringify(rows) });
    const response = await GET(request({ 'X-Job-Token': 'header-secret' }), context());
    expect(await response.text()).toBe(RESULT_TABLE_HEADER + 'target_sequence\t181\t280\t260\t-\t0.123456789\n'.repeat(2));
  });

  it.each(['##gff-version 3\n# no records\n', '##gff-version 3'])('returns a header-only table for a valid zero-hit GFF3', async (text) => {
    mockService({ text });
    expect(await (await GET(request(), context())).text()).toBe(RESULT_TABLE_HEADER);
  });

  it('supports empty JSON arrays', async () => {
    mockService({ mode: 'predict', source: 'scores.json', text: '[]' });
    expect(await (await GET(request(), context())).text()).toBe(RESULT_TABLE_HEADER);
  });

  it('uses NA for unknown window geometry on old jobs', async () => {
    mockService({ summary: null, fai: null });
    const response = await GET(request(), context());
    expect(await response.text()).toContain('chr1\tNA\tNA\t220\t-\t0.95000000');
  });

  it('can retain forward windows when only the reference index is missing', async () => {
    mockService({ fai: null });
    const text = await (await GET(request(), context())).text();
    expect(text).toContain('chr1\t1\t100\t81\t+');
    expect(text).toContain('chr1\tNA\tNA\t220\t-');
  });

  it('does not claim TSV support for Parquet-only legacy tasks', async () => {
    mockService({ source: 'scores.parquet' });
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('rejects missing credentials without contacting the service', async () => {
    const mock = mockService();
    expect((await GET(request({}), context())).status).toBe(404);
    expect(mock).not.toHaveBeenCalled();
  });

  it.each(['', '/artifacts/summary.json', '/artifacts/input.fasta.fai', '/artifacts/scores.gff3'])('propagates expired access at %s instead of returning an empty download', async (failedPath) => {
    mockService({ failedPath });
    const response = await GET(request(), context());
    expect(response.status).toBe(410);
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it.each(['', '<html>Service error</html>', 'chr1\tx\tx\t0\t0\t.9\t+\t.\t.', 'chr1\tx\tx\t1\t1\tnan\t+\t.\t.'])('rejects invalid GFF3 before setting download headers', async (text) => {
    mockService({ text });
    const response = await GET(request(), context());
    expect(response.status).toBe(502);
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('terminates the stream on corrupt later records rather than completing a partial table', async () => {
    mockService({ text: gff + 'broken record\n' });
    const response = await GET(request(), context());
    await expect(response.text()).rejects.toThrow();
  });

  it('supports HEAD while leaving ranges on the generated table as full responses', async () => {
    const mock = mockService();
    const response = await HEAD(request({ 'X-Job-Token': 'test', Range: 'bytes=0-50' }, 'HEAD'), context());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(mock.mock.calls.at(-1)?.[1]?.method).toBe('HEAD');
    expect(response.headers.get('accept-ranges')).toBeNull();
  });

  it('preserves the existing Range proxy for browser artifacts', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('bytes', { status: 206, headers: { 'Content-Range': 'bytes 0-4/100', 'Accept-Ranges': 'bytes' } }));
    vi.stubGlobal('fetch', mock);
    const response = await GET(request({ 'X-Job-Token': 'test', Range: 'bytes=0-4' }), context('scores.plus.bw'));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-4/100');
    expect((mock.mock.calls[0][1].headers as Headers).get('Range')).toBe('bytes=0-4');
    expect(await response.text()).toBe('bytes');
  });
});

describe('streamed source parsing', () => {
  function chunked(text: string) {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 7));
      offset += 7;
    } });
  }
  const geometry = { windowLength: 100, sequenceLength: 300, lengths: new Map<string, number>() };

  it('handles UTF-8, quoted identifiers and JSON objects split across transport chunks', async () => {
    const data = [{ sequence_id: '序列"{a}', window_start_0based: 0, anchor_position_0based: 80, strand: '+', score: .31 }];
    const stream = await resultTableStream(chunked(JSON.stringify(data)), 'json', geometry);
    expect(await new Response(stream).text()).toContain('"序列""{a}"\t1\t100\t81\t+\t0.31\n');
  });

  it('handles GFF3 records and CRLF split across chunks', async () => {
    const stream = await resultTableStream(chunked(gff.replaceAll('\n', '\r\n')), 'gff3', { ...geometry, lengths: new Map([['chr1', 300], ['chr2', 200]]) });
    expect((await new Response(stream).text()).trim().split('\n')).toHaveLength(4);
  });

  it.each(['{}', '[null]', '[', '[{"sequence_id":"x"}]', '[]junk'])('rejects malformed or incomplete JSON: %s', async (text) => {
    await expect(resultTableStream(chunked(text), 'json', geometry)).rejects.toThrow();
  });

  it('rejects truncation after a valid JSON row', async () => {
    const text = JSON.stringify([{ sequence_id: 'x', strand: '+', score: .5, window_start_0based: 0, anchor_position_0based: 80 }]).slice(0, -1);
    const stream = await resultTableStream(chunked(text), 'json', geometry);
    await expect(new Response(stream).text()).rejects.toThrow();
  });
});
