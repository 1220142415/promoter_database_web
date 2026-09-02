import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, HEAD } from '@/app/api/prediction-reference/[accession]/route';

const originalFetch = global.fetch;
const context = (accession: string) => ({ params: Promise.resolve({ accession }) });

afterEach(() => {
  global.fetch = originalFetch;
});

describe('prediction reference proxy', () => {
  it('restricts the route to explicitly configured prediction references', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const response = await GET(new Request('http://localhost/test'), context('GCF_000000001.1'));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams the versioned E. coli reference with safe immutable headers', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      return new Response('gzip-bytes', {
        headers: {
          'Content-Length': '10',
          ETag: 'ncbi-etag',
          'Last-Modified': 'Fri, 31 Oct 2014 23:59:39 GMT',
        },
      });
    });
    global.fetch = fetchMock;

    const response = await GET(new Request('http://localhost/test'), context('GCF_000005845.2'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/gzip');
    expect(response.headers.get('content-disposition')).toContain('GCF_000005845.2_ASM584v2_genomic.fna.gz');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('etag')).toBe('ncbi-etag');
    expect(await response.text()).toBe('gzip-bytes');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/005/845/');
  });

  it('uses HEAD upstream and rejects an unexpectedly large reference', async () => {
    global.fetch = vi.fn(async () => new Response(null, {
      headers: { 'Content-Length': String(11 * 1024 * 1024) },
    }));

    const response = await HEAD(new Request('http://localhost/test'), context('GCF_000005845.2'));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'Prediction reference has an invalid size.' });
  });
});
