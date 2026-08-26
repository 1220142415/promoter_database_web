import { afterEach, describe, expect, it, vi } from 'vitest';

const { resolveAsset } = vi.hoisted(() => ({ resolveAsset: vi.fn() }));
vi.mock('@/features/genome-browser/experimental-tss-repository', () => ({ experimentalTssRepository: { resolveAsset } }));

import { GET, HEAD } from '@/app/api/experimental-data/[accession]/[...asset]/route';

const originalFetch = global.fetch;
const accession = 'GCF_000210855.2';

function context(asset: string[], selectedAccession = accession) {
  return { params: Promise.resolve({ accession: selectedAccession, asset }) };
}

afterEach(() => {
  global.fetch = originalFetch;
  resolveAsset.mockReset();
});

describe('experimental data asset proxy', () => {
  it('does not fetch unknown accessions, studies or file names', async () => {
    resolveAsset.mockResolvedValue(null);
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const response = await GET(new Request('http://localhost/test'), context(['studies', '..', 'secret']));
    expect(response.status).toBe(404);
    expect(resolveAsset).toHaveBeenCalledWith(accession, 'studies/../secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards byte ranges for indexed browser assets', async () => {
    resolveAsset.mockResolvedValue({
      upstreamUrl: 'https://example.test/release/study.gff3.gz', filename: 'study.gff3.gz',
      contentType: 'application/gzip', sha256: 'a'.repeat(64), kind: 'experimental-tss',
    });
    global.fetch = vi.fn(async (_url, init) => {
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('range')).toBe('bytes=10-19');
      return new Response('0123456789', { status: 206, headers: { 'Content-Length': '10', 'Content-Range': 'bytes 10-19/100', 'Accept-Ranges': 'bytes' } });
    });

    const response = await GET(
      new Request('http://localhost/test', { headers: { Range: 'bytes=10-19' } }),
      context(['studies', '2012_22251276_GCF_000210855.2', 'experimental-tss.gff3.gz']),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(response.headers.get('content-type')).toBe('application/gzip');
    expect(response.headers.get('content-disposition')).toContain('inline');
  });

  it('uses attachment disposition only for explicit downloads and supports HEAD', async () => {
    resolveAsset.mockResolvedValue({
      upstreamUrl: 'https://example.test/release/source.bed', filename: 'study.bed',
      contentType: 'text/tab-separated-values; charset=utf-8', sha256: null, kind: 'raw-bed',
    });
    global.fetch = vi.fn(async (_url, init) => {
      expect(init?.method).toBe('HEAD');
      return new Response(null, { headers: { 'Content-Length': '25' } });
    });
    const response = await HEAD(new Request('http://localhost/test?download=1'), context(['studies', '2012_22251276_GCF_000210855.2', 'raw.bed']));
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="study.bed"');
  });

  it('rejects an upstream that ignores a requested byte range', async () => {
    resolveAsset.mockResolvedValue({ upstreamUrl: 'https://example.test/file', filename: 'file.gz', contentType: 'application/gzip', sha256: null, kind: 'reference' });
    global.fetch = vi.fn(async () => new Response('full', { status: 200 }));
    const response = await GET(new Request('http://localhost/test', { headers: { Range: 'bytes=0-1' } }), context(['reference.fa.gz']));
    expect(response.status).toBe(502);
  });

  it.each([
    ['wrong start', 'bytes=10-19', 'bytes 11-19/100', '9'],
    ['wrong end', 'bytes=10-19', 'bytes 10-18/100', '9'],
    ['wrong content length', 'bytes=10-19', 'bytes 10-19/100', '9'],
    ['open range cut short', 'bytes=90-', 'bytes 90-98/100', '9'],
    ['wrong suffix range', 'bytes=-10', 'bytes 89-98/100', '10'],
  ])('rejects a 206 response with %s', async (_label, range, contentRange, contentLength) => {
    resolveAsset.mockResolvedValue({ upstreamUrl: 'https://example.test/file', filename: 'file.gz', contentType: 'application/gzip', sha256: null, kind: 'reference' });
    global.fetch = vi.fn(async () => new Response('x'.repeat(Number(contentLength)), {
      status: 206,
      headers: { 'Content-Range': contentRange, 'Content-Length': contentLength },
    }));
    const response = await GET(new Request('http://localhost/test', { headers: { Range: range } }), context(['reference.fa.gz']));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'Experimental release asset returned an invalid byte range.' });
  });

  it('accepts open-ended and suffix ranges only when the returned interval is exact', async () => {
    resolveAsset.mockResolvedValue({ upstreamUrl: 'https://example.test/file', filename: 'file.gz', contentType: 'application/gzip', sha256: null, kind: 'reference' });
    global.fetch = vi.fn(async (_url, init) => {
      const range = new Headers(init?.headers).get('range');
      return range === 'bytes=-10'
        ? new Response('x'.repeat(10), { status: 206, headers: { 'Content-Range': 'bytes 90-99/100', 'Content-Length': '10' } })
        : new Response('x'.repeat(10), { status: 206, headers: { 'Content-Range': 'bytes 90-99/100', 'Content-Length': '10' } });
    });
    expect((await GET(new Request('http://localhost/test', { headers: { Range: 'bytes=90-' } }), context(['reference.fa.gz']))).status).toBe(206);
    expect((await GET(new Request('http://localhost/test', { headers: { Range: 'bytes=-10' } }), context(['reference.fa.gz']))).status).toBe(206);
  });

  it.each(['bytes=0-1,4-5', 'items=0-1', 'bytes=5-4', 'bytes=-0'])('rejects invalid or multiple ranges before contacting storage: %s', async (range) => {
    resolveAsset.mockResolvedValue({ upstreamUrl: 'https://example.test/file', filename: 'file.gz', contentType: 'application/gzip', sha256: null, kind: 'reference' });
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const response = await GET(new Request('http://localhost/test', { headers: { Range: range } }), context(['reference.fa.gz']));
    expect(response.status).toBe(416);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
