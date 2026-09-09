import { afterEach, describe, expect, it, vi } from 'vitest';

const repositories = vi.hoisted(() => ({
  getByAccession: vi.fn(),
  resolveAsset: vi.fn(),
}));

vi.mock('@/features/genomes/repository', () => ({
  genomeCatalogRepository: { getByAccession: repositories.getByAccession },
}));
vi.mock('@/features/genome-browser/experimental-tss-repository', () => ({
  experimentalTssRepository: { resolveAsset: repositories.resolveAsset },
}));

import {
  loadPredictionReference,
  referenceSourceFromMatch,
  resolvePredictionReferenceSource,
} from '@/features/prediction/reference-source';
import type { GenomeCatalogMatch } from '@/features/genomes/types';
import { REAL_PREDICTION_REFERENCE } from '@/features/prediction/reference-example';


function match(accession: string, url: string, sha256: string) {
  return {
    genome: { accession },
    plannedAssets: { reference: url, cacheVersions: { reference: sha256 } },
  } as unknown as GenomeCatalogMatch;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('prediction reference source', () => {
  it('resolves the built-in example by its exact .2 accession and compressed checksum', async () => {
    repositories.getByAccession.mockResolvedValue(match(
      'GCF_000005845.1', 'https://example.test/wrong-version.fna.gz', '1'.repeat(64),
    ));
    await expect(resolvePredictionReferenceSource('GCF_000005845.2')).resolves.toEqual({
      url: REAL_PREDICTION_REFERENCE.sourceUrl,
      sha256: REAL_PREDICTION_REFERENCE.compressedSha256,
    });
    expect(repositories.getByAccession).not.toHaveBeenCalled();
    expect(repositories.resolveAsset).not.toHaveBeenCalled();
  });

  it('returns the Worker-resolved HTTPS URL and checksum', () => {
    const accession = 'GCF_000005845.1';
    expect(referenceSourceFromMatch(
      accession,
      match(accession, 'https://huggingface.co/datasets/example/repo/resolve/main/genome.fna', 'a'.repeat(64)),
    )).toEqual({
      url: 'https://huggingface.co/datasets/example/repo/resolve/main/genome.fna',
      sha256: 'a'.repeat(64),
    });
  });

  it('rejects an accession mismatch or unsafe URL', () => {
    const accession = 'GCF_000005845.1';
    expect(referenceSourceFromMatch(
      accession,
      match('GCF_000006745.1', 'https://huggingface.co/reference.fna', 'a'.repeat(64)),
    )).toBeNull();
    expect(referenceSourceFromMatch(
      accession,
      match(accession, 'http://example.test/reference.fna', 'a'.repeat(64)),
    )).toBeNull();
  });

  it('constructs the direct URL for an individual ready release', () => {
    const accession = 'GCF_000005845.1';
    const ready = {
      genome: { accession, assets: { fasta: `${accession}/reference.fa.gz` } },
      storage: {
        layout: 'individual-v1',
        logicalObjectPrefix: accession,
        baseUrl: 'https://huggingface.co/datasets/example/repo/resolve/main/objects',
      },
      details: { referenceSha256: 'b'.repeat(64) },
    } as unknown as GenomeCatalogMatch;
    expect(referenceSourceFromMatch(accession, ready)).toEqual({
      url: `https://huggingface.co/datasets/example/repo/resolve/main/objects/${accession}/reference.fa.gz`,
      sha256: 'b'.repeat(64),
    });
  });

  it('falls back to the experimental genome collection', async () => {
    const accession = 'GCF_000005845.1';
    repositories.getByAccession.mockResolvedValue(null);
    repositories.resolveAsset.mockResolvedValue({
      upstreamUrl: 'https://huggingface.co/datasets/example/repo/resolve/main/reference.fa.gz',
      sha256: 'c'.repeat(64),
    });

    await expect(resolvePredictionReferenceSource(accession)).resolves.toEqual({
      url: 'https://huggingface.co/datasets/example/repo/resolve/main/reference.fa.gz',
      sha256: 'c'.repeat(64),
    });
    expect(repositories.resolveAsset).toHaveBeenCalledWith(accession, 'reference.fa.gz');
  });

  it('rejects an unsafe experimental asset', async () => {
    repositories.getByAccession.mockResolvedValue(null);
    repositories.resolveAsset.mockResolvedValue({
      upstreamUrl: 'http://example.test/reference.fa.gz',
      sha256: 'c'.repeat(64),
    });

    await expect(resolvePredictionReferenceSource('GCF_000005845.1')).resolves.toBeNull();
  });
});

describe('bounded reference download', () => {
  it('propagates network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await expect(loadPredictionReference()).rejects.toThrow('unavailable');
  });
  it('rejects a corrupt gzip without supplying substitute sequence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('corrupt-reference')));
    await expect(loadPredictionReference()).rejects.toThrow();
  });
  it('cancels streaming when the compressed size limit is exceeded', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)); }, cancel,
    }))));
    await expect(loadPredictionReference()).rejects.toThrow('size limit');
    expect(cancel).toHaveBeenCalled();
  });
});
