// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExperimentalTssJBrowseViewer from '@/features/genome-browser/components/experimental-tss-jbrowse-viewer';
import type { ExperimentalTssGenome, ExperimentalTssStudy } from '@/types/experimental-tss';

vi.mock('@jbrowse/react-linear-genome-view', () => ({
  createViewState: vi.fn(),
}));

vi.mock('@/features/genome-browser/components/rapptor-jbrowse-linear-view', () => ({
  default: () => <div data-testid="mock-experimental-jbrowse" />,
}));

import { createViewState } from '@jbrowse/react-linear-genome-view';

const assemblyName = 'GCF_000210855.2';

function study(studyId: string, pmid: string): ExperimentalTssStudy {
  return {
    studyId,
    datasetRow: 1,
    accession: assemblyName,
    organismName: 'Test bacterium',
    pmid,
    year: 2012,
    recordCount: 123,
    sourceFile: `${studyId}.bed`,
    sourceSha256: 'a'.repeat(64),
    duplicateGroupCount: 2,
    publication: {
      title: `Study ${pmid}`,
      authors: ['A. Author'],
      journal: 'Genome Journal',
      doi: null,
      status: 'resolved',
    },
    assets: {
      rawBed: `studies/${studyId}/raw.bed`,
      data: `studies/${studyId}/experimental-tss.gff3.gz`,
      index: `studies/${studyId}/experimental-tss.gff3.gz.tbi`,
    },
    checksums: {},
  };
}

function genome(withAnnotation = true): ExperimentalTssGenome {
  return {
    releaseId: 'experimental-2026-08-25',
    accession: assemblyName,
    organismName: 'Test bacterium',
    strain: null,
    assemblyName,
    genbankAssemblyAccession: 'GCA_000210855.2',
    defaultLocus: 'NC_016810.1:1000-2000',
    primarySequence: 'NC_016810.1',
    genomeSizeBp: 2000000,
    contigCount: 1,
    annotationStatus: withAnnotation ? 'available' : 'missing',
    assetBase: 'https://huggingface.co/datasets/example/release/resolve/main',
    assets: {
      fasta: 'genomes/GCF_000210855.2/reference.fa.gz',
      fastaFai: 'genomes/GCF_000210855.2/reference.fa.gz.fai',
      fastaGzi: 'genomes/GCF_000210855.2/reference.fa.gz.gzi',
      ncbiAnnotations: withAnnotation ? 'genomes/GCF_000210855.2/ncbi.gff3.gz' : null,
      ncbiAnnotationsIndex: withAnnotation ? 'genomes/GCF_000210855.2/ncbi.gff3.gz.tbi' : null,
    },
    studies: [study('study-22251276', '22251276'), study('study-22538806', '22538806')],
  };
}

function mockTrack(configuration: string, height: number) {
  return { configuration, displays: [{ height, heightPreConfig: height }] };
}

function stateTree() {
  const view = {
    width: 1000,
    initialized: true,
    displayedRegions: [{
      assemblyName,
      refName: 'NC_016810.1',
      start: 1000,
      end: 2000,
      reversed: false,
    }],
    bpPerPx: 0.5,
    tracks: [
      mockTrack(`${assemblyName}-reference-sequence`, 120),
      mockTrack(`${assemblyName}-ncbi-annotations`, 170),
      mockTrack(`${assemblyName}-experimental-tss-study-22251276`, 170),
      mockTrack(`${assemblyName}-experimental-tss-study-22538806`, 190),
    ],
    pxToBp: vi.fn((px: number) => ({
      assemblyName,
      refName: 'NC_016810.1',
      coord: px === 500 ? 1500 : px === 0 ? 1250 : 1750,
      index: 0,
      oob: false,
      offset: 0,
      start: 1000,
      end: 2000,
      reversed: false,
    })),
    navToLocString: vi.fn().mockResolvedValue(undefined),
    zoomTo: vi.fn(),
  };
  return { session: { view } };
}

describe('experimental TSS JBrowse viewer', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', `/experimental-tss/genomes/${assemblyName}`);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.mocked(createViewState).mockReset();
    vi.mocked(createViewState).mockImplementation(() => stateTree() as never);
  });

  it('configures reference, optional annotation and every study as separate feature tracks', () => {
    render(<ExperimentalTssJBrowseViewer genome={genome()} />);
    expect(screen.getByTestId('mock-experimental-jbrowse')).toBeInTheDocument();
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      assembly: { sequence: { adapter: Record<string, unknown> } };
      tracks: Array<{
        trackId: string;
        name: string;
        adapter: Record<string, unknown>;
        metadata: Record<string, unknown>;
        displays: Array<{ renderer: { type: string } }>;
      }>;
      plugins: Array<{ name: string }>;
      defaultSession: { view: { tracks: Array<{ configuration: string }> } };
    };
    expect(config.assembly.sequence.adapter).toMatchObject({ type: 'BgzipFastaAdapter' });
    expect(config.tracks.map((track) => track.name)).toEqual([
      'NCBI genome annotation',
      'Experimental TSS · PMID 22251276',
      'Experimental TSS · PMID 22538806',
    ]);
    expect(config.tracks.slice(1).map((track) => track.displays[0].renderer.type)).toEqual([
      'RAPPTORExperimentalTssRenderer',
      'RAPPTORExperimentalTssRenderer',
    ]);
    expect(config.tracks.slice(1).every((track) => track.adapter.type === 'Gff3TabixAdapter')).toBe(true);
    expect(config.tracks[1].metadata).toMatchObject({
      rapptorEvidenceType: 'experimental_tss',
      rapptorStudy: { studyId: 'study-22251276', pmid: '22251276', recordCount: 123 },
      rapptorExperimentalDownloads: [
        expect.objectContaining({ kind: 'raw-bed', url: expect.stringContaining('/raw.bed') }),
        expect.objectContaining({ kind: 'normalized-gff3', url: expect.stringContaining('/experimental-tss.gff3.gz') }),
      ],
    });
    expect(config.defaultSession.view.tracks.map((track) => track.configuration)).toEqual([
      `${assemblyName}-reference-sequence`,
      `${assemblyName}-ncbi-annotations`,
      `${assemblyName}-experimental-tss-study-22251276`,
      `${assemblyName}-experimental-tss-study-22538806`,
    ]);
    expect(config.plugins.map((plugin) => plugin.name)).toEqual([
      'RapptorStrandFeaturePlugin',
      'RapptorExperimentalTssPlugin',
      'RapptorTrackDownloadPlugin',
    ]);
  });

  it('omits unavailable annotation without dropping experimental tracks', () => {
    render(<ExperimentalTssJBrowseViewer genome={genome(false)} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as { tracks: Array<{ name: string }> };
    expect(config.tracks.map((track) => track.name)).toEqual([
      'Experimental TSS · PMID 22251276',
      'Experimental TSS · PMID 22538806',
    ]);
  });

  it('restores dynamic study order, heights, reverse orientation and exact zoom', async () => {
    window.history.replaceState(
      {},
      '',
      `/experimental-tss/genomes/${assemblyName}?view=1&ref=NC_016810.1&center=1500&zoom=0.25&rev=1&tracks=study.study-22538806:220,sequence:130,study.study-22251276:180`,
    );
    const tree = stateTree();
    tree.session.view.pxToBp.mockImplementation((px: number) => ({
      assemblyName,
      refName: 'NC_016810.1',
      coord: px === 500 ? 1500 : px === 0 ? 1250 : 1750,
      index: 0,
      oob: false,
      offset: 0,
      start: 1000,
      end: 2000,
      reversed: true,
    }));
    vi.mocked(createViewState).mockReturnValue(tree as never);
    render(<ExperimentalTssJBrowseViewer genome={genome()} />);

    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      defaultSession: { view: { tracks: Array<{ configuration: string; displays: Array<{ heightPreConfig: number }> }> } };
    };
    expect(config.defaultSession.view.tracks.map((track) => track.configuration)).toEqual([
      `${assemblyName}-experimental-tss-study-22538806`,
      `${assemblyName}-reference-sequence`,
      `${assemblyName}-experimental-tss-study-22251276`,
    ]);
    expect(config.defaultSession.view.tracks.map((track) => track.displays[0].heightPreConfig)).toEqual([220, 130, 180]);
    await waitFor(() => {
      expect(tree.session.view.navToLocString).toHaveBeenCalledWith('NC_016810.1:1500[rev]', assemblyName);
      expect(tree.session.view.zoomTo).toHaveBeenCalledWith(0.25, 500);
    });
  });

  it('shares only the whitelisted dynamic study tracks from the current view', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    window.history.replaceState({}, '', `/experimental-tss/genomes/${assemblyName}?private=discard`);
    render(<ExperimentalTssJBrowseViewer genome={genome()} />);
    const button = screen.getByRole('button', { name: 'Share current experimental TSS view' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
    const url = new URL(writeText.mock.calls[0][0]);
    expect([...url.searchParams.keys()]).toEqual(['view', 'ref', 'center', 'zoom', 'rev', 'tracks']);
    expect(url.searchParams.get('tracks')).toBe(
      'sequence:120,annotation:170,study.study-22251276:170,study.study-22538806:190',
    );
  });

  it('rejects an unknown study token and falls back to the genome default locus', async () => {
    window.history.replaceState(
      {},
      '',
      `/experimental-tss/genomes/${assemblyName}?view=1&ref=NC_016810.1&center=1500&zoom=1&rev=0&tracks=study.attacker:170`,
    );
    const tree = stateTree();
    vi.mocked(createViewState).mockReturnValue(tree as never);
    render(<ExperimentalTssJBrowseViewer genome={genome()} />);
    await waitFor(() => expect(tree.session.view.navToLocString).toHaveBeenCalledWith('NC_016810.1:1000-2000', assemblyName));
    expect(tree.session.view.zoomTo).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/invalid.*default view/i);
  });
});
