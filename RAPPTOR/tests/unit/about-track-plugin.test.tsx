// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getSession } from '@jbrowse/core/util';
import {
  RapptorAbout,
  replaceRapptorAbout,
} from '@/features/genome-browser/plugins/about-track-plugin';

vi.mock('@jbrowse/core/util', async (importOriginal) => ({
  ...await importOriginal<typeof import('@jbrowse/core/util')>(),
  getSession: vi.fn(),
}));

function renderAbout(config: Record<string, unknown>) {
  return render(<RapptorAbout config={config} />);
}

describe('RAPPTOR About track presentation', () => {
  it.each([
    ['reference', 'reference'],
    ['scores-plus', 'scores'],
    ['annotation', 'annotation'],
  ])('shows the contig name instead of the internal assembly key for a live %s track', (kind, panel) => {
    renderAbout({
      assemblyNames: ['prediction-private-job'],
      metadata: {
        rapptorAssembly: { label: 'Contig', name: 'NC_000913.3' },
        rapptorDownload: { kind, accession: 'prediction-private-job' },
      },
    });
    const about = screen.getByTestId(`rapptor-about-${panel}`);
    expect(about).toHaveTextContent('Contig');
    expect(about).toHaveTextContent('NC_000913.3');
    expect(about).not.toHaveTextContent('Input');
    expect(about).not.toHaveTextContent('prediction-private-job');
    expect(about).not.toHaveTextContent('Assembly');
  });

  it('uses the currently displayed contig after navigation instead of the initial reference', () => {
    vi.mocked(getSession).mockReturnValueOnce({ view: { displayedRegions: [{ refName: 'contig_2' }] } } as never);
    renderAbout({
      metadata: {
        rapptorAssembly: { label: 'Contig', name: 'contig_1' },
        rapptorDownload: { kind: 'reference', accession: 'prediction-private-job' },
      },
    });
    expect(screen.getByText('contig_2')).toBeInTheDocument();
    expect(screen.queryByText('contig_1')).not.toBeInTheDocument();
  });

  it('shows curated prediction details while hiding implementation metadata', () => {
    renderAbout({
      type: 'FeatureTrack',
      trackId: 'internal-predicted-track',
      name: 'RAPPTOR promoter predictions',
      assemblyNames: ['GCF_000006985.1'],
      adapter: { type: 'Gff3Adapter', gffLocation: { uri: 'blob:private' } },
      metadata: {
        rapptorDownload: {
          kind: 'promoters',
          accession: 'GCF_000006985.1',
          label: 'RAPPTOR promoter predictions',
          wholeAssetUrl: '/api/private.gff3',
        },
        rapptorEvidenceType: 'prediction',
        rapptorProcessing: { sigma: 1, distance: 10, cutoff: 0.9, positionBase: 0 },
        rapptorStrandFeatureMode: 'promoter',
      },
    });

    expect(screen.getByTestId('rapptor-about-promoters')).toBeInTheDocument();
    expect(screen.getByText('Model threshold')).toBeInTheDocument();
    expect(screen.getByText('0.90')).toBeInTheDocument();
    expect(screen.queryByText('Evidence')).not.toBeInTheDocument();
    expect(screen.queryByText('RAPPTOR prediction')).not.toBeInTheDocument();
    expect(screen.queryByText('Gaussian smoothing sigma')).not.toBeInTheDocument();
    expect(screen.queryByText('Minimum peak distance')).not.toBeInTheDocument();
    expect(screen.queryByText('Coordinates')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('FeatureTrack');
    expect(document.body).not.toHaveTextContent('internal-predicted-track');
    expect(document.body).not.toHaveTextContent('Gff3Adapter');
    expect(document.body).not.toHaveTextContent('blob:private');
    expect(document.body).not.toHaveTextContent('File info');
    expect(document.body).not.toHaveTextContent('Show ref names');
    expect(document.body).not.toHaveTextContent('Copy config');
  });

  it('keeps reference About concise', () => {
    renderAbout({
      type: 'ReferenceSequenceTrack',
      trackId: 'internal-reference-track',
      name: 'Reference sequence',
      metadata: {
        rapptorDownload: {
          kind: 'reference',
          accession: 'GCF_000006985.1',
          label: 'Reference sequence',
          wholeAssetUrl: 'blob:reference',
        },
      },
    });
    expect(screen.getByTestId('rapptor-about-reference')).toBeInTheDocument();
    expect(screen.getByText('Assembly')).toBeInTheDocument();
    expect(screen.getByText('GCF_000006985.1')).toBeInTheDocument();
    expect(screen.getByText('FASTA')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('blob:reference');
  });

  it('labels experimental TSS as published observations and preserves useful links', () => {
    renderAbout({
      type: 'FeatureTrack',
      trackId: 'internal-experimental-track',
      name: 'Experimental TSS · 2018 · PMID 29150516',
      assemblyNames: ['GCF_000006985.1'],
      metadata: {
        rapptorEvidenceType: 'experimental_tss',
        rapptorStudy: {
          pmid: '29150516',
          year: 2018,
          recordCount: 8876,
          title: 'Differential RNA Sequencing study',
          journal: 'Applied and environmental microbiology',
          authors: ['Hilzinger JM', 'Raman V'],
          pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/29150516/',
          doiUrl: 'https://doi.org/10.1128/AEM.01966-17',
        },
        rapptorExperimentalDownloads: [{
          kind: 'raw-bed',
          url: '/api/experimental-data/GCF_000006985.1/studies/study/raw.bed',
        }],
      },
    });
    expect(screen.getByTestId('rapptor-about-experimental')).toHaveTextContent('Published observations');
    expect(screen.getByText('8,876')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open PubMed record' })).toHaveAttribute('href', 'https://pubmed.ncbi.nlm.nih.gov/29150516/');
    expect(screen.getByRole('link', { name: 'Open DOI' })).toHaveAttribute('href', 'https://doi.org/10.1128/AEM.01966-17');
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('experimental_tss');
    expect(document.body).not.toHaveTextContent('internal-experimental-track');
  });

  it('shows readable NCBI annotation provenance without URLs or adapter fields', () => {
    renderAbout({
      type: 'FeatureTrack',
      trackId: 'internal-annotation-track',
      name: 'NCBI genome annotation',
      assemblyNames: ['GCF_000006985.1'],
      metadata: {
        rapptorDownload: { kind: 'ncbi', accession: 'GCF_000006985.1', label: 'NCBI genome annotation', wholeAssetUrl: 'blob:annotation' },
        rapptorStrandFeatureMode: 'annotation',
        rapptorAnnotation: {
          genomeBuild: 'ASM698v1',
          genomeBuildAccession: 'GCF_000006985.1',
          annotationDate: '2024-12-09T13:41:33Z',
          annotationSource: 'NCBI RefSeq GCF_000006985.1-RS_2024_12_09',
          processor: 'NCBI annotwriter',
          sequenceRegions: [{ refName: 'NC_002932.3', start: 1, end: 2154946 }],
        },
      },
    });
    expect(screen.getByTestId('rapptor-about-annotation')).toHaveTextContent('Genome build');
    expect(screen.getByText('ASM698v1')).toBeInTheDocument();
    expect(screen.getByText(/NC_002932\.3/)).toBeInTheDocument();
    expect(screen.getByText('Format')).toBeInTheDocument();
    expect(screen.getByText('GFF3')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Gff3Adapter');
    expect(document.body).not.toHaveTextContent('blob:annotation');
    expect(document.body).not.toHaveTextContent('NCBI annotwriter');
  });

  it('leaves unrelated tracks on the native About component', () => {
    const Original = () => <div data-testid="native-about">Native About</div>;
    expect(replaceRapptorAbout(Original, { config: { type: 'FeatureTrack', name: 'User track', metadata: {} } })).toBe(Original);
    const Component = replaceRapptorAbout(Original, {
      config: {
        type: 'FeatureTrack',
        name: 'RAPPTOR promoter predictions',
        metadata: { rapptorEvidenceType: 'prediction' },
      },
    });
    render(<Component config={{ type: 'FeatureTrack', name: 'RAPPTOR promoter predictions', metadata: { rapptorEvidenceType: 'prediction' } }} />);
    expect(screen.getByTestId('rapptor-about-promoters')).toBeInTheDocument();
  });
});
