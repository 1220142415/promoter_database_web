import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, HEAD } from '@/app/api/remote-data/[accession]/[file]/route';

const accession = 'GCA_000411415.1';
const originalFetch = global.fetch;

function context(file: string, selectedAccession = accession) {
  return { params: Promise.resolve({ accession: selectedAccession, file }) };
}

afterEach(() => {
  global.fetch = originalFetch;
  Object.defineProperty(globalThis, 'caches', { value: undefined, configurable: true, writable: true });
  delete process.env.HF_PILOT_ACCESSIONS;
  delete process.env.HF_PILOT_STORAGE_BASE_URL;
  delete process.env.HF_STORAGE_BASE_URL;
});

describe('remote pilot asset proxy', () => {
  it('restricts accessions and file names before remote fetch', async () => {
    process.env.HF_PILOT_ACCESSIONS = accession;
    process.env.HF_PILOT_STORAGE_BASE_URL = 'https://example.test/objects';
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    expect((await GET(new Request('http://localhost/test'), context('metadata.json', 'GCA_000000001.1'))).status).toBe(404);
    expect((await GET(new Request('http://localhost/test'), context('../secret'))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards Range and streams safe response headers', async () => {
    process.env.HF_PILOT_ACCESSIONS = accession;
    process.env.HF_PILOT_STORAGE_BASE_URL = 'https://example.test/objects';
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '10', 'Accept-Ranges': 'bytes' } });
      expect(new Headers(init?.headers).get('range')).toBe('bytes=2-5');
      return new Response('2345', { status: 206, headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': '4',
        'Content-Range': 'bytes 2-5/10',
        'Content-Type': 'application/json',
        ETag: 'pilot-etag',
      } });
    });
    global.fetch = fetchMock;

    const response = await GET(new Request('http://localhost/test', { headers: { range: 'bytes=2-5' } }), context('metadata.json'));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('etag')).toBe('pilot-etag');
    expect(await response.text()).toBe('2345');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['HEAD', 'GET']);
  });

  it('serves individual BigWig score assets with a stable content type', async () => {
    process.env.HF_PILOT_ACCESSIONS = accession;
    process.env.HF_PILOT_STORAGE_BASE_URL = 'https://example.test/objects';
    global.fetch = vi.fn(async () => new Response('BW', {
      headers: { 'Content-Length': '2', 'Content-Type': 'application/octet-stream' },
    }));

    const response = await GET(new Request('http://localhost/test'), context('promoter-scores.plus.bw'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-bigwig');
    expect(await response.text()).toBe('BW');
  });

  it('caches range metadata and responses by asset and range', async () => {
    process.env.HF_PILOT_ACCESSIONS = accession;
    process.env.HF_PILOT_STORAGE_BASE_URL = 'https://example.test/objects';
    const entries = new Map<string, Response>();
    Object.defineProperty(globalThis, 'caches', { configurable: true, writable: true, value: {
      default: {
        match: async (request: Request) => entries.get(request.url),
        put: async (request: Request, response: Response) => { entries.set(request.url, response); },
      },
    } });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '10', 'Accept-Ranges': 'bytes' } });
      const range = new Headers(init?.headers).get('range') || 'bytes=2-5';
      const contentRange = range === 'bytes=6-9' ? 'bytes 6-9/10' : 'bytes 2-5/10';
      return new Response(range === 'bytes=6-9' ? '6789' : '2345', { status: 206, headers: {
        'Accept-Ranges': 'bytes', 'Content-Length': '4', 'Content-Range': contentRange, ETag: 'pilot-etag',
      } });
    });
    global.fetch = fetchMock;

    const request = (range = 'bytes=2-5') => new Request('http://localhost/test?release=2026-08-07', { headers: { range } });
    const first = await GET(request(), context('metadata.json'));
    const second = await GET(request(), context('metadata.json'));
    const third = await GET(request('bytes=6-9'), context('metadata.json'));
    expect(first.status).toBe(206);
    expect(first.headers.get('x-seqedge-cache')).toBe('MISS');
    expect(first.headers.get('cache-control')).toContain('immutable');
    expect(second.status).toBe(206);
    expect(second.headers.get('x-seqedge-cache')).toBe('HIT');
    expect(third.status).toBe(206);
    expect(third.headers.get('content-range')).toBe('bytes 6-9/10');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['HEAD', 'GET', 'GET']);
  });

  it('serves ranged HEAD from legacy metadata without fetching the body', async () => {
    process.env.HF_PILOT_ACCESSIONS = accession;
    process.env.HF_PILOT_STORAGE_BASE_URL = 'https://example.test/objects';
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      return new Response(null, {
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': '10',
          'Content-Type': 'application/json',
        },
      });
    });
    global.fetch = fetchMock;

    const response = await HEAD(
      new Request('http://localhost/test', { headers: { range: 'bytes=2-5' } }),
      context('metadata.json'),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.body).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('HEAD');
  });

  it('uses HEAD upstream without returning a response body', async () => {
    process.env.HF_PILOT_ACCESSIONS = accession;
    process.env.HF_PILOT_STORAGE_BASE_URL = 'https://example.test/objects';
    global.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      return new Response(null, { headers: { 'Content-Length': '10' } });
    });

    const response = await HEAD(new Request('http://localhost/test'), context('metadata.json'));
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it('allows any catalog accession when the complete release is configured', async () => {
    process.env.HF_STORAGE_BASE_URL = 'https://example.test/objects';
    const fetchMock = vi.fn(async () => new Response('{}'));
    global.fetch = fetchMock;

    expect((await GET(new Request('http://localhost/test'), context('metadata.json'))).status).toBe(200);
    expect((await GET(new Request('http://localhost/test'), context('metadata.json', 'GCA_000000001.1'))).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not contact storage for staged catalog resources', async () => {
    process.env.HF_STORAGE_BASE_URL = 'https://example.test/objects';
    const repository = await import('@/lib/genome-catalog-repository');
    const lookup = vi.spyOn(repository.genomeCatalogRepository, 'getByAccession').mockResolvedValue({
      releaseId: 'gtdb-r214-2026-08-13',
      assetBase: null,
      genome: {} as never,
      storage: null,
      resourceStatus: 'staged',
    });
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const response = await GET(new Request('http://localhost/test'), context('reference.fa.gz'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Genome release assets are still being prepared.' });
    expect(fetchMock).not.toHaveBeenCalled();
    lookup.mockRestore();
  });

  it('translates packed logical ranges and rewrites response headers', async () => {
    process.env.HF_STORAGE_BASE_URL = 'https://example.test';
    const packed = {
      layout: 'packed-v1' as const,
      logicalObjectPrefix: '7f/' + accession,
      baseUrl: 'https://example.test',
      assets: {
        'metadata.json': {
          packPath: 'releases/2026-08-11/packs/pack-7f-000.bin',
          offset: 4096,
          length: 10,
          sha256: 'a'.repeat(64),
          contentType: 'application/json',
        },
      },
    };
    const repository = await import('@/lib/genome-catalog-repository');
    const lookup = vi.spyOn(repository.genomeCatalogRepository, 'getByAccession').mockResolvedValue({
      releaseId: '2026-08-11',
      assetBase: '/api/remote-data',
      genome: {} as never,
      storage: packed,
    });
    global.fetch = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=4098-4101');
      return new Response('2345', { status: 206, headers: { 'Content-Range': 'bytes 4098-4101/9999', 'Content-Length': '4' } });
    });

    const response = await GET(new Request('http://localhost/test', { headers: { range: 'bytes=2-5' } }), context('metadata.json'));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('content-length')).toBe('4');
    expect(await response.text()).toBe('2345');
    lookup.mockRestore();
  });

  it('serves packed BigWig fragments as range-addressable score assets', async () => {
    process.env.HF_STORAGE_BASE_URL = 'https://example.test';
    const repository = await import('@/lib/genome-catalog-repository');
    const lookup = vi.spyOn(repository.genomeCatalogRepository, 'getByAccession').mockResolvedValue({
      releaseId: '2026-08-11', assetBase: '/api/remote-data', genome: {} as never,
      storage: { layout: 'packed-v1', logicalObjectPrefix: '00/' + accession, baseUrl: 'https://example.test', assets: {
        'promoter-scores.minus.bw': {
          packPath: 'releases/2026-08-11/packs/pack-00-000.bin', offset: 8192, length: 10,
          sha256: 'c'.repeat(64), contentType: 'application/x-bigwig',
        },
      } },
    });
    global.fetch = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=8194-8197');
      return new Response('WIG!', { status: 206, headers: { 'Content-Range': 'bytes 8194-8197/9999', 'Content-Length': '4' } });
    });
    const response = await GET(
      new Request('http://localhost/test', { headers: { range: 'bytes=2-5' } }),
      context('promoter-scores.minus.bw'),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('application/x-bigwig');
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await response.text()).toBe('WIG!');
    lookup.mockRestore();
  });

  it('serves packed HEAD from metadata and rejects invalid packed ranges', async () => {
    process.env.HF_STORAGE_BASE_URL = 'https://example.test';
    const repository = await import('@/lib/genome-catalog-repository');
    const lookup = vi.spyOn(repository.genomeCatalogRepository, 'getByAccession').mockResolvedValue({
      releaseId: '2026-08-11', assetBase: '/api/remote-data', genome: {} as never,
      storage: { layout: 'packed-v1', logicalObjectPrefix: '00/' + accession, baseUrl: 'https://example.test', assets: {
        'metadata.json': { packPath: 'pack.bin', offset: 0, length: 10, sha256: 'b'.repeat(64), contentType: 'application/json' },
      } },
    });
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const head = await HEAD(new Request('http://localhost/test'), context('metadata.json'));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(fetchMock).not.toHaveBeenCalled();
    const rangedHead = await HEAD(new Request('http://localhost/test', { headers: { range: 'bytes=2-5' } }), context('metadata.json'));
    expect(rangedHead.status).toBe(206);
    expect(rangedHead.headers.get('content-range')).toBe('bytes 2-5/10');
    for (const value of ['bytes=10-', 'bytes=0-1,4-5']) {
      const response = await GET(new Request('http://localhost/test', { headers: { range: value } }), context('metadata.json'));
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */10');
    }
    lookup.mockRestore();
  });
});
