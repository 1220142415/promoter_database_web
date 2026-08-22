import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET, HEAD } from '@/app/api/local-data/[accession]/[file]/route';

const accession = 'GCA_000411415.1';
let root = '';

function context(file: string, selectedAccession = accession) {
  return { params: Promise.resolve({ accession: selectedAccession, file }) };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'seqedge-local-data-'));
  await mkdir(join(root, accession), { recursive: true });
  await writeFile(join(root, accession, 'metadata.json'), '0123456789');
  await writeFile(join(root, accession, 'reference.fa'), '>contig_1\nACGT\n');
  await writeFile(join(root, accession, 'promoter-scores.plus.bw'), 'BIGWIGDATA');
  process.env.LOCAL_DATA_ROOT = root;
});

afterAll(async () => {
  delete process.env.LOCAL_DATA_ROOT;
  await rm(root, { recursive: true, force: true });
});

describe('local release asset route', () => {
  it('rejects invalid accessions and files before filesystem access', async () => {
    const invalidAccession = await GET(new Request('http://localhost/test'), context('metadata.json', '../GCA_000411415.1'));
    const invalidFile = await GET(new Request('http://localhost/test'), context('../metadata.json'));
    const unlistedFile = await GET(new Request('http://localhost/test'), context('secrets.txt'));
    expect([invalidAccession.status, invalidFile.status, unlistedFile.status]).toEqual([404, 404, 404]);
  });

  it('serves a whitelisted file and supports HEAD', async () => {
    const response = await GET(new Request('http://localhost/test'), context('metadata.json'));
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toContain('filename="metadata.json"');
    expect(await response.text()).toBe('0123456789');

    const head = await HEAD(new Request('http://localhost/test'), context('metadata.json'));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get('content-length')).toBe('10');
  });

  it('serves the plain FASTA used by an explicit unindexed local release', async () => {
    const response = await GET(new Request('http://localhost/test'), context('reference.fa'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('>contig_1\nACGT\n');
  });

  it('uses a sanitized requested attachment filename with the original file extension', async () => {
    const response = await GET(new Request('http://localhost/test?filename=../renamed.txt'), context('metadata.json'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('filename="renamed.json"');
  });

  it('serves BigWig score assets with byte ranges', async () => {
    const response = await GET(
      new Request('http://localhost/test', { headers: { range: 'bytes=0-3' } }),
      context('promoter-scores.plus.bw'),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toContain('application/x-bigwig');
    expect(response.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(await response.text()).toBe('BIGW');
  });

  it.each([
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=8-99', '89', 'bytes 8-9/10'],
  ])('serves a valid single range %s', async (range, expectedBody, expectedHeader) => {
    const response = await GET(new Request('http://localhost/test', { headers: { range } }), context('metadata.json'));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(expectedHeader);
    expect(await response.text()).toBe(expectedBody);
  });

  it.each(['bytes=10-', 'bytes=5-4', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-0'])('returns 416 for invalid range %s', async (range) => {
    const response = await GET(new Request('http://localhost/test', { headers: { range } }), context('metadata.json'));
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
  });
});
