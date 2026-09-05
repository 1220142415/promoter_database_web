import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

const { resolveAsset } = vi.hoisted(() => ({ resolveAsset: vi.fn() }));
vi.mock('@/features/genome-browser/experimental-tss-repository', () => ({ experimentalTssRepository: { resolveAsset } }));

import { GET, HEAD } from '@/app/api/experimental-data/[accession]/[...asset]/route';

const originalFetch = global.fetch;
const originalFlag = process.env.RAPPTOR_EXPERIMENTAL_TSS_PUBLIC_PAGE;
const accession = 'GCF_000210855.2';

function context(asset: string[], selectedAccession = accession) {
  return { params: Promise.resolve({ accession: selectedAccession, asset }) };
}

beforeEach(() => { process.env.RAPPTOR_EXPERIMENTAL_TSS_PUBLIC_PAGE = 'on'; });

afterEach(() => {
  global.fetch = originalFetch;
  resolveAsset.mockReset();
  if (originalFlag === undefined) delete process.env.RAPPTOR_EXPERIMENTAL_TSS_PUBLIC_PAGE;
  else process.env.RAPPTOR_EXPERIMENTAL_TSS_PUBLIC_PAGE = originalFlag;
});

describe('experimental data asset proxy', () => {
  it('returns 404 without resolving assets when public access is off', async () => {
    process.env.RAPPTOR_EXPERIMENTAL_TSS_PUBLIC_PAGE = 'off';
    const response = await GET(new Request('http://localhost/test'), context(['reference.fa.gz']));
    expect(response.status).toBe(404);
    expect(resolveAsset).not.toHaveBeenCalled();
  });

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

  it('honors a sanitized BED download filename without changing the observations', async () => {
    const body = 'NC_016810.1\t9\t10\tTSS\t.\t+\n';
    resolveAsset.mockResolvedValue({
      upstreamUrl: 'https://example.test/release/source.bed', filename: 'study.bed',
      contentType: 'text/tab-separated-values; charset=utf-8', sha256: null, kind: 'raw-bed',
    });
    global.fetch = vi.fn(async () => new Response(body));
    const response = await GET(new Request('http://localhost/test?download=1&filename=..%2Fmy%20study.txt'), context(['studies', 'study', 'raw.bed']));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="my_study.bed"');
    expect(await response.text()).toBe(body);
    const inline = await GET(new Request('http://localhost/test?filename=other.bed'), context(['studies', 'study', 'raw.bed']));
    expect(inline.headers.get('content-disposition')).toBe('inline; filename="study.bed"');
  });

  it('converts an existing study BED to browser-ready GFF3', async () => {
    resolveAsset.mockResolvedValue({
      upstreamUrl: 'https://example.test/existing-study.bed', filename: 'study.experimental-tss.gff3',
      contentType: 'text/plain; charset=utf-8', sha256: 'a'.repeat(64), kind: 'experimental-tss',
      transform: {
        kind: 'experimental-bed-to-gff3', accession, studyId: '2012_22251276_GCF_000210855.2',
        pmid: '22251276', year: 2012, sourceFile: 'source.bed',
      },
    });
    global.fetch = vi.fn(async () => new Response(
      `${accession}:NC_016810.1\t9\t10\t.\t.\t+\n`,
      { headers: { 'Content-Length': '50' } },
    ));

    const response = await GET(
      new Request('http://localhost/test'),
      context(['studies', '2012_22251276_GCF_000210855.2', 'experimental-tss.gff3']),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBeNull();
    await expect(response.text()).resolves.toContain(
      'NC_016810.1\tRAPPTOR\texperimental_tss\t10\t10\t.\t+\t.\tID=2012_22251276_GCF_000210855.2%3A1',
    );
  });

  it('decompresses an existing FASTA and normalizes its reference name', async () => {
    resolveAsset.mockResolvedValue({
      upstreamUrl: 'https://example.test/reference.fna.gz', filename: 'reference.fa',
      contentType: 'text/plain; charset=utf-8', sha256: null, kind: 'reference',
      transform: { kind: 'gunzip', refName: 'NC_016810.1' },
    });
    global.fetch = vi.fn(async () => new Response(gzipSync('>AE000001.1 original description\nACGT\n')));

    const response = await GET(new Request('http://localhost/test'), context(['reference.fa']));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('>NC_016810.1 original description\nACGT\n');
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
