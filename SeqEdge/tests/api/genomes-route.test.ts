import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedGenomeSearchResponse } from '@/types/unified-genome';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/unified-genome-repository', () => {
  class UnifiedGenomeCursorError extends Error {}
  return { UnifiedGenomeCursorError, unifiedGenomeRepository: { search: vi.fn() } };
});

import { GET } from '@/app/api/genomes/route';
import { GenomeCatalogUnavailableError } from '@/lib/genome-catalog-repository';
import { UnifiedGenomeCursorError, unifiedGenomeRepository } from '@/lib/unified-genome-repository';

const response: UnifiedGenomeSearchResponse = {
  releases: { predictionReleaseId: 'prediction-1', experimentalReleaseId: 'experimental-1', compositeRevision: 'combined-1' },
  items: [],
  total: 0,
  facets: {
    sources: [],
    taxonomy: { domain: [], phylum: [], class: [], order: [], family: [], genus: [] },
    evidence: { prediction_only: 0, experimental_only: 0, both: 0 },
  },
  stats: {
    totalGenomes: 0, predictionGenomes: 0, experimentalGenomes: 0, bothGenomes: 0,
    totalPredictedPromoters: 0, totalExperimentalObservations: 0, totalExperimentalStudies: 0, totalExperimentalPublications: 0,
  },
  pageInfo: { nextCursor: null, hasNext: false },
};

describe('GET /api/genomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(unifiedGenomeRepository.search).mockResolvedValue(response);
  });

  it('queries the unified catalog with all evidence by default', async () => {
    const result = await GET(new Request('http://localhost/api/genomes'));
    expect(result.status).toBe(200);
    expect(unifiedGenomeRepository.search).toHaveBeenCalledWith(expect.objectContaining({ evidence: 'all', limit: 25 }));
    expect(await result.json()).toEqual(response);
  });

  it.each(['predictions', 'experimental', 'both'] as const)('accepts the %s evidence filter', async (evidence) => {
    const result = await GET(new Request(`http://localhost/api/genomes?evidence=${evidence}`));
    expect(result.status).toBe(200);
    expect(unifiedGenomeRepository.search).toHaveBeenCalledWith(expect.objectContaining({ evidence }));
  });

  it('rejects unknown evidence filters and invalid page sizes', async () => {
    expect((await GET(new Request('http://localhost/api/genomes?evidence=validation'))).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/genomes?limit=20'))).status).toBe(400);
    expect(unifiedGenomeRepository.search).not.toHaveBeenCalled();
  });

  it('returns 400 for unified cursor failures', async () => {
    vi.mocked(unifiedGenomeRepository.search).mockRejectedValue(new UnifiedGenomeCursorError('invalid cursor'));
    const result = await GET(new Request('http://localhost/api/genomes?cursor=not-a-cursor'));
    expect(result.status).toBe(400);
  });

  it('returns 503 when an active release is unavailable', async () => {
    vi.mocked(unifiedGenomeRepository.search).mockRejectedValue(new GenomeCatalogUnavailableError('prediction unavailable'));
    const result = await GET(new Request('http://localhost/api/genomes'));
    expect(result.status).toBe(503);
  });
});
