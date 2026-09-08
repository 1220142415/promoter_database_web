import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, HEAD } from '@/app/api/cyanobacteria-data/[genomeId]/[...file]/route';
import { cyanobacteriaAssetVersion } from '@/features/cyanobacteria/catalog';
import scoreRelease from '@/generated/experimental-score-release.json';
import continuousRelease from '@/generated/cyanobacteria-continuous-score-release.json';

let root = '';
const previousRoot = process.env.CYANOBACTERIA_DATA_ROOT;
const previousBase = process.env.CYANOBACTERIA_ASSET_BASE_URL;
const previousScoreRoot = process.env.CYANOBACTERIA_CONTINUOUS_SCORE_ROOT;
const originalFetch = global.fetch;
const publication = continuousRelease as { revision: string | null };
const previousRevision = publication.revision;

function context(genomeId: string, ...file: string[]) {
  return { params: Promise.resolve({ genomeId, file }) };
}

beforeEach(async () => {
  publication.revision = null;
  root = await mkdtemp(join(tmpdir(), 'rapptor-cyanobacteria-route-'));
  await mkdir(join(root, 'ASM970v1'), { recursive: true });
  await writeFile(join(root, 'ASM970v1', 'reference.fa.gz'), Buffer.from('0123456789'));
  await writeFile(join(root, 'ASM970v1', 'experimentally-supported-tss.gff3.gz'), Buffer.from('experimental'));
  await mkdir(join(root, 'ASM970v1', 'sources'));
  await writeFile(join(root, 'ASM970v1', 'sources', 'experimentally-supported-tss.source.bed.gz'), Buffer.from('original compressed BED'));
  process.env.CYANOBACTERIA_DATA_ROOT = root;
  process.env.CYANOBACTERIA_CONTINUOUS_SCORE_ROOT = root;
  delete process.env.CYANOBACTERIA_ASSET_BASE_URL;
});

afterEach(async () => {
  publication.revision = previousRevision;
  global.fetch = originalFetch;
  if (root) await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.CYANOBACTERIA_DATA_ROOT;
  else process.env.CYANOBACTERIA_DATA_ROOT = previousRoot;
  if (previousBase === undefined) delete process.env.CYANOBACTERIA_ASSET_BASE_URL;
  else process.env.CYANOBACTERIA_ASSET_BASE_URL = previousBase;
  if (previousScoreRoot === undefined) delete process.env.CYANOBACTERIA_CONTINUOUS_SCORE_ROOT;
  else process.env.CYANOBACTERIA_CONTINUOUS_SCORE_ROOT = previousScoreRoot;
});

describe('cyanobacteria release asset route', () => {
  it.each(['ASM970v1', 'Cf6912', 'CP003597.1'])('serves both verified continuous strands for %s', async (genomeId) => {
    global.fetch = vi.fn();
    const directory = join(root, continuousRelease.version, genomeId);
    await mkdir(directory, { recursive: true });
    for (const strand of ['plus', 'minus']) {
      const file = `promoter_scores.sigma1.${strand}.bw`;
      const bytes = new Uint8Array([0x26, 0xfc, 0x8f, 0x88, 1, 2, 3, 4]);
      await writeFile(join(directory, file), bytes);
      const filename = `${genomeId}.${file}`;
      const route = context(genomeId, `v-${continuousRelease.version}`, file);
      const response = await GET(new Request(`http://localhost/test?download=1&filename=${filename}`, { headers: { Range: 'bytes=0-3' } }), route);
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-3/8');
      expect(response.headers.get('content-type')).toBe('application/x-bigwig');
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${filename}"`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(0, 4));
      const head = await HEAD(new Request('http://localhost/test'), route);
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe('8');
      expect(head.body).toBeNull();
      expect((await GET(new Request('http://localhost/test', { headers: { Range: 'bytes=8-' } }), route)).status).toBe(416);
      expect((await GET(new Request('http://localhost/test'), context(genomeId, `v-${continuousRelease.version}`, '..', file))).status).toBe(404);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['ASM970v1', 'Cf6912', 'CP003597.1'].flatMap(genome => ['plus', 'minus'].map(strand => [genome, strand])))('serves published %s %s scores through their pinned version', async (genomeId, strand) => {
    publication.revision = 'test-published-revision';
    const expectedUrl = `https://huggingface.co/datasets/${continuousRelease.repository}/resolve/${publication.revision}/${continuousRelease.scorePath}/${genomeId}/promoter_scores.sigma1.${strand}.bw`;
    global.fetch = vi.fn(async (url, init) => {
      expect(url).toBe(expectedUrl);
      if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '10' } });
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-3');
      return new Response(new Uint8Array([0x26, 0xfc, 0x8f, 0x88]), {
        status: 206, headers: { 'Content-Length': '4', 'Content-Range': 'bytes 0-3/10' },
      });
    });
    const filename = `${genomeId}.promoter_scores.sigma1.${strand}.bw`;
    const response = await GET(new Request(`http://localhost/test?download=1&filename=${filename}`, { headers: { Range: 'bytes=0-3' } }),
      context(genomeId, `v-${publication.revision}`, `promoter_scores.sigma1.${strand}.bw`));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(response.headers.get('content-type')).toBe('application/x-bigwig');
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${filename}"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x26, 0xfc, 0x8f, 0x88]));
    const head = await HEAD(new Request('http://localhost/test'),
      context(genomeId, `v-${publication.revision}`, `promoter_scores.sigma1.${strand}.bw`));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(head.body).toBeNull();
  });

  it('does not substitute continuous scores for other assemblies, old versions, or arbitrary paths', async () => {
    global.fetch = vi.fn();
    for (const [genome, version, file] of [
      ['Cf6912', scoreRelease.revision, 'promoter_scores.sigma1.plus.bw'],
      ['CP003597.1', scoreRelease.revision, 'promoter_scores.sigma1.plus.bw'],
      ['ASM970v1', scoreRelease.revision, 'promoter_scores.sigma1.plus.bw'],
      ['ASM970v1', cyanobacteriaAssetVersion, 'promoter_scores.sigma1.plus.bw'],
      ['ASM970v1', scoreRelease.revision, '../promoter_scores.sigma1.plus.bw'],
      ['ASM970v1', scoreRelease.revision, 'reference.fa.gz'],
    ]) {
      expect((await GET(new Request('http://localhost/test'), context(genome, `v-${version}`, file))).status).toBe(404);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps the BED compression extension when a download is renamed', async () => {
    const response = await GET(new Request('http://localhost/test?filename=my_study.bed.gz&download=1'),
      context('ASM970v1', `v-${cyanobacteriaAssetVersion}`, 'sources', 'experimentally-supported-tss.source.bed.gz'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="my_study.bed.gz"');
    expect(await response.text()).toBe('original compressed BED');
  });

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

    const experimental = await GET(
      new Request('http://localhost/api/cyanobacteria-data/ASM970v1/experimentally-supported-tss.gff3.gz'),
      context('ASM970v1', 'experimentally-supported-tss.gff3.gz'),
    );
    expect(experimental.status).toBe(200);
    expect(await experimental.text()).toBe('experimental');
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
