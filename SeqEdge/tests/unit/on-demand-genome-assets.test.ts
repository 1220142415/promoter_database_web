import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstFastaRefName, loadCachedGenomeAsset, maybeDecompressGzip } from '@/lib/on-demand-genome-assets';

describe('on-demand genome assets', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the first FASTA reference name', () => {
    expect(firstFastaRefName('>NC_000001.1 description\nACGT\n')).toBe('NC_000001.1');
    expect(firstFastaRefName('not fasta')).toBeNull();
  });

  it('leaves an uncompressed blob unchanged', async () => {
    const blob = new Blob(['>contig\nACGT\n'], { type: 'text/plain' });
    await expect(maybeDecompressGzip(blob)).resolves.toBe(blob);
  });

  it('uses Cache Storage without repeating the network request', async () => {
    const cachedResponse = new Response('cached genome');
    const cache = { match: vi.fn().mockResolvedValue(cachedResponse) } as unknown as Cache;
    const fetchMock = vi.fn();
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) });
    vi.stubGlobal('fetch', fetchMock);

    const blob = await loadCachedGenomeAsset(
      'https://huggingface.co/genome.fna.gz',
      'release/accession/reference',
      new AbortController().signal,
    );

    expect(await blob.text()).toBe('cached genome');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores a downloaded asset without application-managed eviction', async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn(),
      delete: vi.fn(),
    } as unknown as Cache;
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) });
    const fetchMock = vi.fn().mockResolvedValue(new Response('downloaded genome'));
    vi.stubGlobal('fetch', fetchMock);

    await loadCachedGenomeAsset(
      'https://huggingface.co/genome.fna.gz',
      'release/accession/reference',
      new AbortController().signal,
    );

    expect(cache.put).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://huggingface.co/genome.fna.gz',
      expect.objectContaining({
        cache: 'no-cache',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(cache.keys).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
  });
});
