// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UnifiedJBrowseViewer, { inspectUnifiedJBrowseFailures } from '@/features/genome-browser/components/unified-jbrowse-viewer';
import GenomeFileStatus from '@/features/genome-browser/components/genome-file-status';
import { makeGenome } from '../fixtures/release';
import type { ExperimentalTssGenome, ExperimentalTssStudy } from '@/types/experimental-tss';

vi.mock('@jbrowse/react-linear-genome-view', () => ({ createViewState: vi.fn() }));
vi.mock('@/features/genome-browser/components/rapptor-jbrowse-linear-view', () => ({
  default: () => <div data-testid="mock-unified-jbrowse" />,
}));

import { createViewState } from '@jbrowse/react-linear-genome-view';

const accession = 'GCF_000210855.2';

function study(studyId: string, pmid: string, year: number): ExperimentalTssStudy {
  return {
    studyId,
    datasetRow: 1,
    accession,
    organismName: 'Test bacterium',
    pmid,
    year,
    recordCount: 12,
    sourceFile: `${studyId}.bed`,
    sourceSha256: 'a'.repeat(64),
    duplicateGroupCount: 0,
    publication: { title: `Study ${pmid}`, authors: [], journal: null, doi: null, status: 'resolved' },
    assets: {
      rawBed: `studies/${studyId}/raw.bed`,
      data: `studies/${studyId}/experimental-tss.gff3.gz`,
      index: `studies/${studyId}/experimental-tss.gff3.gz.tbi`,
    },
    checksums: {},
  };
}

function experimental(): ExperimentalTssGenome {
  return {
    releaseId: 'experimental-2026-08-25',
    accession,
    organismName: 'Test bacterium',
    strain: null,
    assemblyName: accession,
    genbankAssemblyAccession: null,
    defaultLocus: 'NC_016810.1:1000-2000',
    primarySequence: 'NC_016810.1',
    genomeSizeBp: 2000000,
    contigCount: 1,
    annotationStatus: 'available',
    assetBase: `/api/experimental-data/${accession}`,
    assets: {
      fasta: 'genomes/reference.fa.gz',
      fastaFai: 'genomes/reference.fa.gz.fai',
      fastaGzi: 'genomes/reference.fa.gz.gzi',
      predictedPromoters: 'genomes/predicted-promoters.gff3',
      predictedPromotersIndex: null,
      ncbiAnnotations: 'genomes/ncbi.gff3.gz',
      ncbiAnnotationsIndex: 'genomes/ncbi.gff3.gz.tbi',
    },
    studies: [study('later-study', '22538806', 2013), study('earlier-study', '22251276', 2012)],
  };
}

function prediction() {
  const genome = makeGenome({ accession });
  genome.assets.promoterScoresPlus = `${accession}/scores.plus.bw`;
  genome.assets.promoterScoresMinus = `${accession}/scores.minus.bw`;
  genome.assets.ncbiAnnotations = `${accession}/annotation.gff3.gz`;
  genome.assets.ncbiAnnotationsIndex = `${accession}/annotation.gff3.gz.tbi`;
  return {
    assemblyName: accession,
    defaultLocus: 'NC_016810.1:1-10000',
    assetBase: '/api/remote-data',
    assets: genome.assets,
  };
}

function experimentalBrowserAssembly() {
  const genome = experimental();
  return {
    assemblyName: genome.assemblyName || genome.accession,
    defaultLocus: genome.defaultLocus,
    assetBase: genome.assetBase,
    adapterMode: 'indexed' as const,
    annotationTrackKind: 'annotation' as const,
    assets: {
      fasta: genome.assets.fasta,
      fastaFai: genome.assets.fastaFai!,
      fastaGzi: genome.assets.fastaGzi!,
      predictedPromoters: genome.assets.predictedPromoters!,
      predictedPromotersIndex: genome.assets.predictedPromotersIndex || '',
      promoterScoresPlus: null,
      promoterScoresMinus: null,
      ncbiAnnotations: genome.assets.ncbiAnnotations,
      ncbiAnnotationsIndex: genome.assets.ncbiAnnotationsIndex,
    },
    trackLabels: { annotation: 'Prodigal / eggNOG CDS annotations' },
  };
}

function stateTree() {
  return {
    session: {
      view: {
        width: 1000,
        initialized: true,
        displayedRegions: [{ refName: 'NC_016810.1' }],
        bpPerPx: 1,
        tracks: [],
        pxToBp: vi.fn(() => ({ refName: 'NC_016810.1', coord: 1500, oob: false, reversed: false })),
        navToLocString: vi.fn().mockResolvedValue(undefined),
        zoomTo: vi.fn(),
      },
    },
  };
}

describe('unified JBrowse viewer', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', `/genomes/${accession}`);
    vi.mocked(createViewState).mockReset();
    vi.mocked(createViewState).mockImplementation(() => stateTree() as never);
  });

  it('places Share view in the genome file status bar', async () => {
    render(<>
      <GenomeFileStatus states={{ reference: 'available', promoters: 'available', annotation: 'available' }} />
      <UnifiedJBrowseViewer prediction={prediction()} experimental={experimental()} />
    </>);

    const slot = screen.getByTestId('genome-file-status-share');
    await waitFor(() => expect(within(slot).getByRole('button', { name: 'Share current view' })).toBeInTheDocument());
    expect(screen.getByTestId('jbrowse-viewer')).not.toContainElement(within(slot).getByRole('button'));
  });

  it('orders prediction and experimental evidence in one state tree', () => {
    render(<UnifiedJBrowseViewer prediction={prediction()} experimental={experimental()} />);
    expect(screen.getByTestId('mock-unified-jbrowse')).toBeInTheDocument();
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      tracks: Array<{ name: string; metadata: Record<string, unknown> }>;
      plugins: Array<{ name: string }>;
      defaultSession: { view: { tracks: Array<{ configuration: string }> } };
    };
    expect(config.tracks.map((track) => track.name)).toEqual([
      'RAPPTOR raw scores (+ / - strands)',
      'RAPPTOR predicted promoters',
      'Experimental TSS · 2012 · PMID 22251276',
      'Experimental TSS · 2013 · PMID 22538806',
      'NCBI genome annotation',
    ]);
    expect(config.defaultSession.view.tracks.map((track) => track.configuration)).toEqual([
      `${accession}-reference-sequence`,
      `${accession}-promoter-scores`,
      `${accession}-predicted-promoters`,
      `${accession}-experimental-tss-earlier-study`,
      `${accession}-experimental-tss-later-study`,
      `${accession}-ncbi-annotations`,
    ]);
    expect(config.plugins.map((plugin) => plugin.name)).toEqual([
      'RapptorMirroredScorePlugin',
      'RapptorStrandFeaturePlugin',
      'RapptorExperimentalTssPlugin',
      'RapptorTrackDownloadPlugin',
    ]);
    expect(config.tracks[1].metadata).toMatchObject({ rapptorEvidenceType: 'prediction' });
    expect(config.tracks[2].metadata).toMatchObject({ rapptorEvidenceType: 'experimental_tss' });
  });

  it('uses the prediction reference location when experimental metadata has a fallback accession', async () => {
    const tree = stateTree();
    vi.mocked(createViewState).mockReturnValue(tree as never);
    const experimentalAssembly = experimental();
    experimentalAssembly.defaultLocus = `${experimentalAssembly.accession}:1-10000`;
    experimentalAssembly.primarySequence = null;
    render(<UnifiedJBrowseViewer prediction={prediction()} experimental={experimentalAssembly} />);
    await waitFor(() => expect(tree.session.view.navToLocString).toHaveBeenCalledWith('NC_016810.1:1-10000', accession));
  });

  it('reuses the existing assembly tracks and flag renderer for an experimental-only catalog genome', () => {
    render(<UnifiedJBrowseViewer prediction={experimentalBrowserAssembly()} experimental={experimental()} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      tracks: Array<{ name: string; adapter: { type: string }; displays: Array<{ renderer: { type: string } }> }>;
      assembly: { sequence: { adapter: { type: string } } };
    };
    expect(config.tracks.map((track) => track.name)).toEqual([
      'RAPPTOR predicted promoters',
      'Experimental TSS · 2012 · PMID 22251276',
      'Experimental TSS · 2013 · PMID 22538806',
      'Prodigal / eggNOG CDS annotations',
    ]);
    expect(config.assembly.sequence.adapter.type).toBe('BgzipFastaAdapter');
    expect(config.tracks[0].adapter.type).toBe('Gff3Adapter');
    expect(config.tracks[1].displays[0].renderer.type).toBe('RAPPTORExperimentalTssRenderer');
  });

  it('uses the shared IndexedFastaAdapter for prediction FASTA and FAI artifacts', () => {
    const assembly = prediction();
    assembly.assets.fasta = '/api/predictions/jobs/job-1/artifacts/input.fasta';
    assembly.assets.fastaFai = '/api/predictions/jobs/job-1/artifacts/input.fasta.fai';
    assembly.assets.fastaGzi = '';
    render(<UnifiedJBrowseViewer prediction={assembly} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      assembly: { sequence: { adapter: { type: string; fastaLocation: { uri: string }; faiLocation: { uri: string } } } };
    };
    expect(config.assembly.sequence.adapter).toMatchObject({
      type: 'IndexedFastaAdapter',
      fastaLocation: { uri: '/api/predictions/jobs/job-1/artifacts/input.fasta' },
      faiLocation: { uri: '/api/predictions/jobs/job-1/artifacts/input.fasta.fai' },
    });
  });

  it('extracts volatile optional-track block failures without treating them as reference failures', () => {
    const failures = inspectUnifiedJBrowseFailures({
      session: { view: { tracks: [{
        configuration: `${accession}-predicted-promoters`,
        displays: [{ blockState: new Map([['block', { error: new Error('track failed') }]]) }],
      }] } },
    }, accession, `${accession}-reference-sequence`, new Map([
      [`${accession}-predicted-promoters`, 'RAPPTOR predicted promoters'],
    ]));
    expect(failures).toEqual({ referenceFailed: false, optionalTrackLabels: ['RAPPTOR predicted promoters'] });
  });

  it('shows a partial-view notice while keeping JBrowse mounted for an optional track failure', async () => {
    const tree = stateTree();
    tree.session.view.tracks = [{
      configuration: `${accession}-predicted-promoters`,
      displays: [{ error: new Error('optional track failed') }],
    }] as never;
    vi.mocked(createViewState).mockReturnValue(tree as never);
    render(<UnifiedJBrowseViewer prediction={prediction()} />);
    await waitFor(() => expect(screen.getByText(/Partial view: RAPPTOR predicted promoters could not be loaded/)).toBeVisible());
    expect(screen.getByTestId('mock-unified-jbrowse')).toBeInTheDocument();
  });

  it('blocks the embedded viewer when the reference assembly fails', async () => {
    const tree = stateTree() as ReturnType<typeof stateTree> & {
      assemblyManager: { get: () => { error: Error } };
    };
    tree.assemblyManager = { get: () => ({ error: new Error('reference failed') }) };
    vi.mocked(createViewState).mockReturnValue(tree as never);
    render(<UnifiedJBrowseViewer prediction={prediction()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('reference sequence could not be loaded'));
    expect(screen.queryByTestId('mock-unified-jbrowse')).not.toBeInTheDocument();
  });
});
