// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HomePage from '@/app/page';
import { makeCatalog, makeGenome } from '../fixtures/release';

vi.mock('server-only', () => ({}));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));
vi.mock('@/lib/genome-catalog-repository', () => ({ genomeCatalogRepository: { getActiveRelease: vi.fn() } }));

import { genomeCatalogRepository } from '@/lib/genome-catalog-repository';

const genomes = Array.from({ length: 1_000 }, (_, index) => makeGenome({
  accession: `GCA_${String(index + 1).padStart(9, '0')}.1`,
  predictedPromoterCount: 10,
  annotationStatus: index < 656 ? 'available' : 'missing',
  annotationFeatureCount: index < 644 ? 100 : 0,
}));

describe('portal home', () => {
  beforeEach(() => {
    const catalog = makeCatalog(genomes);
    vi.mocked(genomeCatalogRepository.getActiveRelease).mockResolvedValue({ ...catalog, sourceReleaseId: '2026-08-07', releaseAssetBaseUrl: null, manifestIndexPath: 'manifest-index.json' });
  });

  it('renders release aggregates without client-side API or whole-catalog requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(await HomePage());

    expect(screen.getByRole('heading', { name: 'SeqEdge' })).toBeInTheDocument();
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('1,000');
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('10,000');
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('NCBI annotations cataloged656');
    expect(screen.getByText('1,000 assemblies')).toBeInTheDocument();
    const downloads = screen.getByLabelText('Release downloads');
    expect(within(downloads).getByRole('link', { name: /Release metadata/ })).toHaveAttribute('href', '/api/local-release/release.json');
    expect(within(downloads).getByRole('link', { name: /File manifest/ })).toHaveAttribute('href', '/api/local-release/manifest.tsv');
    expect(within(downloads).getByRole('link', { name: /Checksums/ })).toHaveAttribute('href', '/api/local-release/checksums.sha256');
    expect(within(downloads).getByRole('link', { name: /Manifest index/ })).toHaveAttribute('href', '/api/local-release/manifest-index.json');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
