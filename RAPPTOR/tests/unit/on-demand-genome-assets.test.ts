import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  firstFastaRefName,
  loadCachedGenomeAsset,
  maybeDecompressGzip,
  readCachedGenomeAsset,
  shouldDownloadWholeAsset,
} from '@/features/genome-browser/on-demand-genome-assets';

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
    const fetchMock = vi.fn().mockResolvedValue(new Response('downloaded genome', {
      headers: { 'Content-Length': '17' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onProgress = vi.fn();

    await loadCachedGenomeAsset(
      'https://huggingface.co/genome.fna.gz',
      'release/accession/reference',
      new AbortController().signal,
      { onProgress },
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
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'downloading', loaded: 17, total: 17 }));
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'cached', loaded: 17, total: 17 });
  });

  it('checks Cache Storage without a network fallback', async () => {
    const cache = { match: vi.fn().mockResolvedValue(new Response('cached scores')) } as unknown as Cache;
    const fetchMock = vi.fn();
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) });
    vi.stubGlobal('fetch', fetchMock);

    const blob = await readCachedGenomeAsset('release/accession/scores-plus');

    expect(await blob?.text()).toBe('cached scores');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects static assets before reading a declared oversized response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('small body', {
      headers: { 'Content-Length': String(65 * 1024 * 1024) },
    })));

    await expect(loadCachedGenomeAsset(
      'https://huggingface.co/oversized.fna.gz',
      'release/accession/reference',
      new AbortController().signal,
    )).rejects.toThrow('64 MiB browser download limit');
  });

  it('rejects an uncompressed asset beyond the decompressed limit', async () => {
    await expect(maybeDecompressGzip(new Blob(['12345']), 4)).rejects.toThrow('4 bytes browser download limit');
  });

  it('downloads small score files and streams large or unknown files', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { headers: { 'Content-Length': String(1024) } }))
      .mockResolvedValueOnce(new Response(null, { headers: { 'Content-Length': String(9 * 1024 * 1024) } }))
      .mockResolvedValueOnce(new Response(null));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;

    await expect(shouldDownloadWholeAsset('https://huggingface.co/small.bw', signal)).resolves.toBe(true);
    await expect(shouldDownloadWholeAsset('https://huggingface.co/large.bw', signal)).resolves.toBe(false);
    await expect(shouldDownloadWholeAsset('https://huggingface.co/unknown.bw', signal)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://huggingface.co/small.bw',
      expect.objectContaining({ method: 'HEAD', credentials: 'omit' }),
    );
  });
});
