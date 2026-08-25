// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GenomeDetailPage from '@/app/genomes/[accession]/page';
import { makeGenome } from '../fixtures/release';
import type { ExperimentalTssGenome } from '@/types/experimental-tss';
import type { GenomeCatalogMatch } from '@/types/genome-catalog';
import type { UnifiedGenomeMatch } from '@/types/unified-genome';

vi.mock('server-only', () => ({}));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));
const permanentRedirect = vi.fn((destination: string) => { throw new Error(`redirect:${destination}`); });
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('not found'); },
  permanentRedirect: (destination: string) => permanentRedirect(destination),
}));
vi.mock('@/components/unified-browser-panel', () => ({
  default: ({ prediction, experimental }: { prediction?: { assemblyName: string } | null; experimental?: ExperimentalTssGenome | null }) => (
    <div
      data-testid="browser-contract"
      data-prediction={prediction?.assemblyName || ''}
      data-experimental={experimental?.accession || ''}
    />
  ),
}));
vi.mock('@/components/portal-on-demand-browser-panel', () => ({ default: ({ accession }: { accession: string }) => <div data-testid="on-demand-browser-contract" data-assembly={accession} /> }));
vi.mock('@/lib/unified-genome-repository', () => ({ unifiedGenomeRepository: { getByAccession: vi.fn() } }));

import { unifiedGenomeRepository } from '@/lib/unified-genome-repository';

const publication = { title: 'Independent TSS map', authors: ['First Author'], journal: 'RNA', doi: '10.1/test', status: 'resolved' as const };
const study = {
  studyId: '2012_22251276_GCF_000210855.2', datasetRow: 1, accession: 'GCF_000210855.2', organismName: 'Escherichia coli',
  pmid: '22251276', year: 2012, recordCount: 5, sourceFile: 'first.bed', sourceSha256: 'a'.repeat(64), duplicateGroupCount: 0,
  publication, assets: { rawBed: 'studies/one/raw.bed', data: 'studies/one/data.gz', index: 'studies/one/data.gz.tbi' }, checksums: {},
};
const experimental: ExperimentalTssGenome = {
  releaseId: 'experimental-1', accession: 'GCF_000210855.2', organismName: 'Escherichia coli', strain: 'K-12', assemblyName: 'GCF_000210855.2',
  genbankAssemblyAccession: 'GCA_000210855.2', defaultLocus: 'NC_016810.1:1-1000', primarySequence: 'NC_016810.1', genomeSizeBp: 5_000_000,
  contigCount: 1, annotationStatus: 'available', assetBase: '/api/experimental-data/GCF_000210855.2',
  assets: { fasta: 'reference.fa.gz', fastaFai: 'reference.fa.gz.fai', fastaGzi: 'reference.fa.gz.gzi', ncbiAnnotations: 'ncbi.gff3.gz', ncbiAnnotationsIndex: 'ncbi.gff3.gz.tbi' },
  studies: [study],
};

function prediction(accession = 'GCA_000411415.1'): GenomeCatalogMatch {
  const genome = makeGenome({ accession, organismName: 'Predicted genome', annotationStatus: 'available' });
  genome.assets.ncbiAnnotations = `${accession}/ncbi.gff3.gz`;
  genome.assets.ncbiAnnotationsIndex = `${accession}/ncbi.gff3.gz.tbi`;
  return { releaseId: 'prediction-1', assetBase: '/api/local-data', genome, storage: { layout: 'individual-v1', logicalObjectPrefix: accession } };
}

function unified(predictionMatch: GenomeCatalogMatch | null, experimentalGenome: ExperimentalTssGenome | null, canonical?: string): UnifiedGenomeMatch {
  const canonicalAccession = canonical || predictionMatch?.genome.accession || experimentalGenome!.accession;
  return {
    canonicalAccession,
    aliases: [canonicalAccession, ...(experimentalGenome?.genbankAssemblyAccession ? [experimentalGenome.genbankAssemblyAccession] : [])],
    evidenceState: predictionMatch && experimentalGenome ? 'both' : predictionMatch ? 'prediction_only' : 'experimental_only',
    assemblyCompatibility: predictionMatch && experimentalGenome ? 'reciprocal_alias' : 'single_source',
    overlayAllowed: Boolean(predictionMatch && experimentalGenome),
    prediction: predictionMatch,
    experimental: experimentalGenome,
    releases: { predictionReleaseId: 'prediction-1', experimentalReleaseId: 'experimental-1', compositeRevision: 'combined-1' },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('unified genome detail', () => {
  it('keeps the prediction-only browser contract and labels experimental evidence as absent', async () => {
    const result = unified(prediction(), null);
    vi.mocked(unifiedGenomeRepository.getByAccession).mockResolvedValue(result);
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: result.canonicalAccession }) }));

    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-prediction', result.canonicalAccession);
    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-experimental', '');
    expect(screen.getByText((_, element) => element?.tagName === 'STRONG' && Boolean(element.textContent?.includes('No experimental')))).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Experimental TSS studies' })).not.toBeInTheDocument();
  });

  it('shows an explicit experimental-only notice, study provenance and HF-backed downloads', async () => {
    const result = unified(null, experimental);
    vi.mocked(unifiedGenomeRepository.getByAccession).mockResolvedValue(result);
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: result.canonicalAccession }) }));

    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-prediction', '');
    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-experimental', experimental.accession);
    expect(screen.getByText('Experimental TSS only')).toBeInTheDocument();
    expect(screen.getAllByText('Not included in the active prediction release')).not.toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Experimental TSS studies' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Original BED' })).toHaveAttribute('href', expect.stringContaining('/api/experimental-data/'));
    expect(screen.getByRole('link', { name: 'Normalized GFF3' })).toBeInTheDocument();
  });

  it('passes compatible prediction and experimental sources to one browser', async () => {
    const predictionMatch = prediction('GCA_000210855.2');
    const result = unified(predictionMatch, experimental, predictionMatch.genome.accession);
    vi.mocked(unifiedGenomeRepository.getByAccession).mockResolvedValue(result);
    render(await GenomeDetailPage({ params: Promise.resolve({ accession: result.canonicalAccession }) }));

    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-prediction', 'GCA_000210855.2');
    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-experimental', 'GCF_000210855.2');
    expect(screen.getByText('Predictions and experimental observations')).toBeInTheDocument();
  });

  it('selects an experimental mismatch variant without overlaying prediction tracks', async () => {
    const result = {
      ...unified(null, experimental, 'GCA_000210855.2'),
      assemblyCompatibility: 'mismatch' as const,
      overlayAllowed: false,
      availableAssemblySources: ['prediction', 'experimental'] as Array<'prediction' | 'experimental'>,
    };
    vi.mocked(unifiedGenomeRepository.getByAccession).mockResolvedValue(result);
    render(await GenomeDetailPage({
      params: Promise.resolve({ accession: result.canonicalAccession }),
      searchParams: Promise.resolve({ assembly: 'experimental' }),
    }));

    expect(unifiedGenomeRepository.getByAccession).toHaveBeenCalledWith(result.canonicalAccession, 'experimental');
    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-prediction', '');
    expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-experimental', experimental.accession);
  });

  it('redirects aliases to the canonical route and preserves only share parameters', async () => {
    const result = unified(prediction('GCA_000210855.2'), experimental, 'GCA_000210855.2');
    vi.mocked(unifiedGenomeRepository.getByAccession).mockResolvedValue(result);

    await expect(GenomeDetailPage({
      params: Promise.resolve({ accession: 'GCF_000210855.2' }),
      searchParams: Promise.resolve({ view: '1', ref: 'NC_016810.1', private: 'secret', tracks: 'sequence:120' }),
    })).rejects.toThrow('redirect:');
    expect(permanentRedirect).toHaveBeenCalledWith('/genomes/GCA_000210855.2?view=1&ref=NC_016810.1&tracks=sequence%3A120');
  });

  it('returns not found for an accession outside both active releases', async () => {
    vi.mocked(unifiedGenomeRepository.getByAccession).mockResolvedValue(null);
    await expect(GenomeDetailPage({ params: Promise.resolve({ accession: 'GCA_999999999.1' }) })).rejects.toThrow('not found');
  });
});
