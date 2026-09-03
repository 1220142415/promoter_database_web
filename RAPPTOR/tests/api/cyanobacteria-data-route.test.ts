import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET, HEAD } from '@/app/api/cyanobacteria-data/[genomeId]/[...file]/route';
import { cyanobacteriaAssetVersion } from '@/features/cyanobacteria/catalog';

let root = '';
const previousRoot = process.env.CYANOBACTERIA_DATA_ROOT;
const previousBase = process.env.CYANOBACTERIA_ASSET_BASE_URL;

function context(genomeId: string, ...file: string[]) {
  return { params: Promise.resolve({ genomeId, file }) };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rapptor-cyanobacteria-route-'));
  await mkdir(join(root, 'ASM970v1'), { recursive: true });
  await writeFile(join(root, 'ASM970v1', 'reference.fa.gz'), Buffer.from('0123456789'));
  process.env.CYANOBACTERIA_DATA_ROOT = root;
  delete process.env.CYANOBACTERIA_ASSET_BASE_URL;
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.CYANOBACTERIA_DATA_ROOT;
  else process.env.CYANOBACTERIA_DATA_ROOT = previousRoot;
  if (previousBase === undefined) delete process.env.CYANOBACTERIA_ASSET_BASE_URL;
  else process.env.CYANOBACTERIA_ASSET_BASE_URL = previousBase;
});

describe('cyanobacteria release asset route', () => {
  it('serves allowlisted files with GET, HEAD, and single byte ranges', async () => {
    const full = await GET(new Request('http://localhost/api/cyanobacteria-data/ASM970v1/reference.fa.gz'), context('ASM970v1', 'reference.fa.gz'));
    expect(full.status).toBe(200);
    expect(await full.text()).toBe('0123456789');
    expect(full.headers.get('accept-ranges')).toBe('bytes');

    const versioned = await GET(
      new Request('http://localhost/test'),
      context('ASM970v1', `v-${cyanobacteriaAssetVersion}`, 'reference.fa.gz'),
    );
    expect(versioned.status).toBe(200);
    expect(await versioned.text()).toBe('0123456789');

    const ranged = await GET(
      new Request('http://localhost/api/cyanobacteria-data/ASM970v1/reference.fa.gz', { headers: { Range: 'bytes=2-5' } }),
      context('ASM970v1', 'reference.fa.gz'),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await ranged.text()).toBe('2345');

    const head = await HEAD(new Request('http://localhost/test'), context('ASM970v1', 'reference.fa.gz'));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(head.body).toBeNull();
  });

  it('rejects unknown IDs, unlisted files, traversal forms, and invalid ranges', async () => {
    expect((await GET(new Request('http://localhost/test'), context('unknown', 'reference.fa.gz'))).status).toBe(404);
    expect((await GET(new Request('http://localhost/test'), context('ASM970v1', 'private.txt'))).status).toBe(404);
    expect((await GET(new Request('http://localhost/test'), context('Cf6912', 'experimentally-supported-tss.gff3.gz'))).status).toBe(404);
    expect((await GET(new Request('http://localhost/test'), context('ASM970v1', 'v-outdated', 'reference.fa.gz'))).status).toBe(404);
    expect((await GET(new Request('http://localhost/test'), context('ASM970v1', 'sources', '..', 'reference.fa.gz'))).status).toBe(404);
    const invalid = await GET(
      new Request('http://localhost/test', { headers: { Range: 'bytes=10-' } }),
      context('ASM970v1', 'reference.fa.gz'),
    );
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe('bytes */10');
  });
});
