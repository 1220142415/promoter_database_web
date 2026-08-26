// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UnifiedGenomeSearchResponse } from '@/types/unified-genome';

vi.mock('server-only', () => ({}));
vi.mock('@/features/genomes/components/genome-explorer', () => ({
  default: ({ initialEvidence }: { initialEvidence: string }) => <div data-testid="unified-explorer" data-evidence={initialEvidence} />,
}));
vi.mock('@/features/genome-browser/unified-genome-repository', () => ({ unifiedGenomeRepository: { search: vi.fn() } }));

import GenomesPage from '@/app/genomes/page';
import { unifiedGenomeRepository } from '@/features/genome-browser/unified-genome-repository';

const result: UnifiedGenomeSearchResponse = {
  releases: { predictionReleaseId: 'prediction-1', experimentalReleaseId: 'experimental-1', compositeRevision: 'combined-1' },
  items: [], total: 0,
  facets: { sources: [], taxonomy: { domain: [], phylum: [], class: [], order: [], family: [], genus: [] }, evidence: { prediction_only: 80, experimental_only: 10, both: 20 } },
  stats: {
    totalGenomes: 110, predictionGenomes: 100, experimentalGenomes: 30, bothGenomes: 20,
    totalPredictedPromoters: 1_000, totalExperimentalObservations: 440_947, totalExperimentalStudies: 98, totalExperimentalPublications: 78,
  },
  pageInfo: { nextCursor: null, hasNext: false },
};

describe('unified genome catalog page', () => {
  it('shows separate release statistics and honors the experimental evidence URL filter', async () => {
    vi.mocked(unifiedGenomeRepository.search).mockResolvedValue(result);
    render(await GenomesPage({ searchParams: Promise.resolve({ evidence: 'experimental' }) }));

    expect(screen.getByText('Prediction genomes').parentElement).toHaveTextContent('100');
    expect(screen.getByText('Experimental genomes').parentElement).toHaveTextContent('30');
    expect(screen.getByText('Both evidence types').parentElement).toHaveTextContent('20');
    expect(screen.getByText('Experimental observations').parentElement).toHaveTextContent('440,947');
    expect(screen.getByTestId('unified-explorer')).toHaveAttribute('data-evidence', 'experimental');
    expect(unifiedGenomeRepository.search).toHaveBeenCalledWith(expect.objectContaining({ evidence: 'experimental' }));
  });
});
