// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GenomeDetailPage from '@/app/genomes/[accession]/page';
import { makeGenome } from '../fixtures/release';
import type { GenomeCatalogMatch } from '@/types/genome-catalog';

vi.mock('server-only', () => ({}));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));
vi.mock('@/components/portal-browser-panel', () => ({ default: ({ assembly }: { assembly: { assemblyName: string; assets: { ncbiAnnotations: string | null } } }) => <div data-testid="browser-contract" data-assembly={assembly.assemblyName} data-ncbi={String(Boolean(assembly.assets.ncbiAnnotations))} /> }));
vi.mock('@/components/portal-on-demand-browser-panel', () => ({ default: ({ accession }: { accession: string }) => <div data-testid="on-demand-browser-contract" data-assembly={accession} /> }));
vi.mock('@/lib/genome-catalog-repository', () => ({ genomeCatalogRepository: { getByAccession: vi.fn() } }));

import { genomeCatalogRepository } from '@/lib/genome-catalog-repository';

function match(accession: string, status: 'available' | 'missing' | 'incompatible'): GenomeCatalogMatch {
  const genome = makeGenome({ accession, organismName: status === 'available' ? 'Annotated genome' : 'Prediction-only genome', annotationStatus: status });
  if (status !== 'missing') {
    genome.annotationFeatureCount = 2_000;
    genome.assets.ncbiAnnotations = `${accession}/ncbi-annotations.gff3.gz`;
    genome.assets.ncbiAnnotationsIndex = `${accession}/ncbi-annotations.gff3.gz.tbi`;
  }
  return { releaseId: '2026-08-07', assetBase: '/api/local-data', genome, storage: { layout: 'individual-v1' as const, logicalObjectPrefix: accession } };
}

describe('genome detail release contract', () => {
  it('renders repeated taxonomy names without duplicate React keys', async () => {
    const repeatedTaxonomy = match('GCA_003563755.1', 'missing');
    Object.assign(repeatedTaxonomy.genome, {
      className: 'SLMV01',
      orderName: 'SLMV01',
      family: 'SLMV01',
      genus: 'SLMV01',
    });
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(repeatedTaxonomy);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      render(await GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_003563755.1' }) }));
      expect(screen.getAllByText('SLMV01')).toHaveLength(4);
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('returns not found for an accession that is not in the catalog', async () => {
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(null);

    await expect(GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_999999999.1' }) })).rejects.toThrow('not found');
  });

  it('shows the NCBI track contract without a duplicate release download list', async () => {
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(match('GCA_000411415.1', 'available'));
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_000411415.1' }) }));

    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-assembly', 'GCA_000411415.1');
    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-ncbi', 'true');
    expect(screen.queryByText('Release assets')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Downloads' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('download'))).toHaveLength(0);
    expect(screen.queryByLabelText('Genome browser downloads')).not.toBeInTheDocument();
  });

  it('omits the NCBI track for GCA_000421325.1', async () => {
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(match('GCA_000421325.1', 'missing'));
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_000421325.1' }) }));

    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-ncbi', 'false');
    expect(screen.queryByRole('link', { name: /NCBI annotation/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('download'))).toHaveLength(0);
  });

  it('withholds incompatible NCBI tracks and downloads even when paths are present', async () => {
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(match('GCA_000431335.1', 'incompatible'));
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_000431335.1' }) }));

    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-ncbi', 'false');
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.queryByText('Incompatible with assembly')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /NCBI annotation/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('download'))).toHaveLength(0);
  });

  it('shows catalog metadata while staged genome files are being prepared', async () => {
    const staged = match('GCA_000411415.1', 'available');
    staged.resourceStatus = 'staged';
    staged.assetBase = null;
    staged.storage = null;
    staged.plannedAssets = {
      reference: 'https://huggingface.co/reference.fa.gz',
      predictedPromoters: 'https://huggingface.co/promoters.gff3',
      ncbiAnnotations: 'https://huggingface.co/annotations.gff3.gz',
      batch: '000',
    };
    vi.mocked(genomeCatalogRepository.getByAccession).mockResolvedValue(staged);
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: staged.genome.accession }) }));

    expect(screen.getByTestId('on-demand-browser-contract')).toHaveAttribute('data-assembly', staged.genome.accession);
    expect(screen.getByText('2,000 cataloged features')).toBeInTheDocument();
    expect(screen.queryByTestId('browser-contract')).not.toBeInTheDocument();
  });
});
