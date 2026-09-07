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
  referenceSourceFromMatch,
  resolvePredictionReferenceSource,
} from '@/features/prediction/reference-source';
import type { GenomeCatalogMatch } from '@/features/genomes/types';


function match(accession: string, url: string, sha256: string) {
  return {
    genome: { accession },
    plannedAssets: { reference: url, cacheVersions: { reference: sha256 } },
  } as unknown as GenomeCatalogMatch;
}

afterEach(() => vi.clearAllMocks());

describe('prediction reference source', () => {
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
