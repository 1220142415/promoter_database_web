// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PortalJBrowseViewer from '@/components/portal-jbrowse-viewer';
import { makeGenome } from '../fixtures/release';

vi.mock('@jbrowse/react-linear-genome-view', () => ({
  createViewState: vi.fn(() => ({ configured: true })),
  JBrowseLinearGenomeView: () => <div data-testid="mock-jbrowse" />,
}));

import { createViewState } from '@jbrowse/react-linear-genome-view';

const mockAssemblyName = 'GCA_000411415.1';

function mockTrack(configuration: string, height: number) {
  return {
    configuration,
    displays: [{ height, heightPreConfig: height }],
  };
}

function makeStateTree() {
  const view = {
    width: 1000,
    initialized: true,
    displayedRegions: [{
      assemblyName: mockAssemblyName,
      refName: mockAssemblyName,
      start: 0,
      end: 10000,
      reversed: false,
    }],
    bpPerPx: 0.5,
    tracks: [
      mockTrack(`${mockAssemblyName}-reference-sequence`, 120),
      mockTrack(`${mockAssemblyName}-promoter-scores`, 180),
      mockTrack(`${mockAssemblyName}-predicted-promoters`, 170),
      mockTrack(`${mockAssemblyName}-ncbi-annotations`, 170),
    ],
    pxToBp: vi.fn(() => ({
      assemblyName: mockAssemblyName,
      refName: mockAssemblyName,
      coord: 4321,
      index: 0,
      oob: false,
      offset: 0,
      start: 0,
      end: 10000,
      reversed: false,
    })),
    navToLocString: vi.fn().mockResolvedValue(undefined),
    zoomTo: vi.fn(),
  };
  return { session: { view } };
}

function assembly(withNcbi: boolean, withScores = false) {
  const accession = withNcbi ? 'GCA_000411415.1' : 'GCA_000421325.1';
  const genome = makeGenome({ accession });
  if (withNcbi) {
    genome.assets.ncbiAnnotations = `${accession}/ncbi-annotations.gff3.gz`;
    genome.assets.ncbiAnnotationsIndex = `${accession}/ncbi-annotations.gff3.gz.tbi`;
  }
  if (withScores) {
    genome.assets.promoterScoresPlus = `${accession}/promoter-scores.plus.bw`;
    genome.assets.promoterScoresMinus = `${accession}/promoter-scores.minus.bw`;
  }
  return { assemblyName: accession, defaultLocus: `${accession}:1-10000`, assetBase: '/api/local-data', assets: genome.assets };
}

describe('release JBrowse configuration', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.mocked(createViewState).mockReset();
    vi.mocked(createViewState).mockImplementation(() => makeStateTree() as never);
  });

  it('configures BGZF reference, predicted promoter, and optional NCBI tracks', () => {
    render(<PortalJBrowseViewer assembly={assembly(true)} />);
    expect(screen.getByTestId('mock-jbrowse')).toBeInTheDocument();
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      assembly: { sequence: { adapter: Record<string, unknown>; metadata: { seqEdgeDownload: { kind: string; visibleRegionDownload: boolean } } } };
      tracks: ReadonlyArray<{
        name: string;
        adapter: Record<string, unknown>;
        displays: ReadonlyArray<{ renderer: { type: string } }>;
        metadata: { seqEdgeDownload: { kind: string }; seqEdgeStrandFeatureMode: string };
      }>;
      plugins: ReadonlyArray<{ name: string }>;
      defaultSession: { view: { tracks: ReadonlyArray<{ displays: ReadonlyArray<{ configuration: string; heightPreConfig: number }> }> } };
    };
    expect(config.assembly.sequence.adapter).toMatchObject({ type: 'BgzipFastaAdapter' });
    expect(config.assembly.sequence.metadata.seqEdgeDownload.kind).toBe('reference');
    expect(config.assembly.sequence.metadata.seqEdgeDownload.visibleRegionDownload).toBe(false);
    expect(config.tracks.map((track) => track.name)).toEqual([
      'RAPPtor predicted promoters',
      'NCBI genome annotation',
    ]);
    expect(config.tracks.map((track) => track.metadata.seqEdgeDownload.kind)).toEqual(['promoters', 'ncbi']);
    expect(config.tracks.map((track) => track.metadata.seqEdgeStrandFeatureMode)).toEqual(['promoter', 'annotation']);
    expect(config.tracks.map((track) => track.displays[0].renderer.type)).toEqual([
      'SeqEdgePromoterFeatureRenderer',
      'SeqEdgeDirectionalAnnotationRenderer',
    ]);
    expect(config.tracks.every((track) => track.adapter.type === 'Gff3TabixAdapter')).toBe(true);
    expect(config.plugins.map((plugin) => plugin.name)).toEqual([
      'SeqEdgeMirroredScorePlugin',
      'SeqEdgeStrandFeaturePlugin',
      'SeqEdgeTrackDownloadPlugin',
    ]);
    expect(config.defaultSession.view.tracks[0].displays[0].configuration).toBe(
      'GCA_000411415.1-reference-sequence-LinearReferenceSequenceDisplay',
    );
    expect(config.defaultSession.view.tracks.map((track) => track.displays[0].heightPreConfig)).toEqual([120, 170, 170]);
  });

  it('does not invent an NCBI track when the release has no NCBI asset', () => {
    render(<PortalJBrowseViewer assembly={assembly(false)} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as { tracks: ReadonlyArray<{ name: string }> };
    expect(config.tracks.map((track) => track.name)).toEqual(['RAPPtor predicted promoters']);
  });

  it('adds one fixed-scale mirrored raw score track before promoter peaks', () => {
    render(<PortalJBrowseViewer assembly={assembly(true, true)} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      tracks: ReadonlyArray<{
        name: string;
        type: string;
        adapter: Record<string, unknown>;
        displays: ReadonlyArray<Record<string, unknown>>;
        metadata: {
          seqEdgeMirroredScore?: boolean;
          seqEdgeDownloads?: ReadonlyArray<{ kind: string; visibleRegionDownload: boolean }>;
        };
      }>;
      defaultSession: { view: { tracks: ReadonlyArray<{ displays: ReadonlyArray<{ heightPreConfig: number }> }> } };
    };
    expect(config.tracks.map((track) => track.name)).toEqual([
      'RAPPtor raw scores (+ / - strands)',
      'RAPPtor predicted promoters',
      'NCBI genome annotation',
    ]);
    expect(config.tracks[0].type).toBe('MultiQuantitativeTrack');
    expect(config.tracks[0].adapter).toMatchObject({
      type: 'MultiWiggleAdapter',
      subadapters: [
        { type: 'BigWigAdapter', source: 'plus', bigWigLocation: { uri: expect.stringContaining('promoter-scores.plus.bw') } },
        { type: 'BigWigAdapter', source: 'minus', bigWigLocation: { uri: expect.stringContaining('promoter-scores.minus.bw') } },
      ],
    });
    expect(config.tracks[0].displays[0]).toMatchObject({
      type: 'MultiLinearWiggleDisplay',
      defaultRendering: 'xyplot',
      minScore: 0,
      maxScore: 1,
      renderers: {
        MultiXYPlotRenderer: { summaryScoreMode: 'max' },
        MultiLineRenderer: { summaryScoreMode: 'max' },
      },
    });
    expect(config.tracks[0].metadata.seqEdgeMirroredScore).toBe(true);
    expect(config.tracks[0].metadata.seqEdgeDownloads).toEqual([
      expect.objectContaining({ kind: 'scores-plus', visibleRegionDownload: false }),
      expect.objectContaining({ kind: 'scores-minus', visibleRegionDownload: false }),
    ]);
    expect(config.defaultSession.view.tracks.map((track) => track.displays[0].heightPreConfig)).toEqual([120, 180, 170, 170]);
  });

  it('uses whole-file adapters for a browser-prepared staged genome', () => {
    const unindexed = { ...assembly(true), adapterMode: 'unindexed' as const };
    unindexed.assets.ncbiAnnotationsIndex = null;
    render(<PortalJBrowseViewer assembly={unindexed} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      assembly: { sequence: { adapter: Record<string, unknown>; metadata: { seqEdgeDownload: { downloadMode: string } } } };
      tracks: ReadonlyArray<{ adapter: Record<string, unknown>; metadata: { seqEdgeDownload: { downloadMode: string } } }>;
    };
    expect(config.assembly.sequence.adapter).toMatchObject({ type: 'UnindexedFastaAdapter' });
    expect(config.tracks).toHaveLength(2);
    expect(config.tracks.every((track) => track.adapter.type === 'Gff3Adapter')).toBe(true);
    expect(config.assembly.sequence.metadata.seqEdgeDownload.downloadMode).toBe('browser');
    expect(config.tracks.every((track) => track.metadata.seqEdgeDownload.downloadMode === 'browser')).toBe(true);
  });

  it('wires view changes to the region download controller', () => {
    const onRegionChange = vi.fn();
    render(<PortalJBrowseViewer assembly={assembly(false)} onRegionChange={onRegionChange} />);
    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as { onChange?: () => void };
    expect(config.onChange).toBeTypeOf('function');
  });

  it('restores the shared reverse view, zoom, and requested track layout', async () => {
    window.history.replaceState(
      {},
      '',
      `/genomes/${mockAssemblyName}?view=1&ref=${mockAssemblyName}&center=4321&zoom=0.25&rev=1&tracks=annotation:210,sequence:130,scores:190`,
    );

    const stateTree = makeStateTree();
    stateTree.session.view.pxToBp.mockReturnValue({
      assemblyName: mockAssemblyName,
      refName: mockAssemblyName,
      coord: 4321,
      index: 0,
      oob: false,
      offset: 0,
      start: 0,
      end: 10000,
      reversed: true,
    });
    vi.mocked(createViewState).mockReturnValue(stateTree as never);
    render(<PortalJBrowseViewer assembly={assembly(true, true)} />);

    const config = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      defaultSession: {
        view: {
          tracks: ReadonlyArray<{
            configuration: string;
            displays: ReadonlyArray<{ heightPreConfig: number }>;
          }>;
        };
      };
    };
    expect(config.defaultSession.view.tracks.map((track) => track.configuration)).toEqual([
      `${mockAssemblyName}-ncbi-annotations`,
      `${mockAssemblyName}-reference-sequence`,
      `${mockAssemblyName}-promoter-scores`,
    ]);
    expect(config.defaultSession.view.tracks.map((track) => track.displays[0].heightPreConfig)).toEqual([210, 130, 190]);

    await waitFor(() => {
      expect(stateTree.session.view.navToLocString).toHaveBeenCalledWith(
        `${mockAssemblyName}:4321[rev]`,
        mockAssemblyName,
      );
      expect(stateTree.session.view.zoomTo).toHaveBeenCalledWith(0.25, 500);
    });
    expect(stateTree.session.view.navToLocString).toHaveBeenCalledOnce();
    expect(stateTree.session.view.zoomTo).toHaveBeenCalledOnce();
    expect(stateTree.session.view.navToLocString.mock.invocationCallOrder[0]).toBeLessThan(
      stateTree.session.view.zoomTo.mock.invocationCallOrder[0],
    );
  });

  it('copies a share link from the current single-region view', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    window.history.replaceState(
      {},
      '',
      `/genomes/${mockAssemblyName}?campaign=discard-me&asset=${encodeURIComponent('blob:private-object')}`,
    );
    render(<PortalJBrowseViewer assembly={assembly(true, true)} />);

    await user.click(screen.getByRole('button', { name: 'Share current view' }));

    expect(await screen.findByText('Link copied')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledOnce();
    const copiedUrl = new URL(writeText.mock.calls[0][0]);
    expect(copiedUrl.pathname).toBe(`/genomes/${mockAssemblyName}`);
    expect([...copiedUrl.searchParams.keys()]).toEqual(['view', 'ref', 'center', 'zoom', 'rev', 'tracks']);
    expect(copiedUrl.searchParams.get('view')).toBe('1');
    expect(copiedUrl.searchParams.get('ref')).toBe(mockAssemblyName);
    expect(copiedUrl.searchParams.get('center')).toBe('4321');
    expect(copiedUrl.searchParams.get('zoom')).toBe('0.5');
    expect(copiedUrl.searchParams.get('rev')).toBe('0');
    expect(copiedUrl.searchParams.get('tracks')).toBe('sequence:120,scores:180,promoters:170,annotation:170');
  });

  it('offers a readonly share link when clipboard access fails', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValueOnce(new Error('permission denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    window.history.replaceState({}, '', `/genomes/${mockAssemblyName}`);
    render(<PortalJBrowseViewer assembly={assembly(true, true)} />);

    await user.click(screen.getByRole('button', { name: 'Share current view' }));

    const fallback = await screen.findByRole('textbox', { name: 'Share link' });
    expect(fallback).toHaveAttribute('readonly');
    expect((fallback as HTMLInputElement).value).toContain(`/genomes/${mockAssemblyName}?view=1`);
  });

  it('falls back to the default locus and warns when a shared ref is unknown', async () => {
    const stateTree = makeStateTree();
    stateTree.session.view.navToLocString
      .mockRejectedValueOnce(new Error('unknown reference'))
      .mockResolvedValueOnce(undefined);
    vi.mocked(createViewState).mockReturnValue(stateTree as never);
    window.history.replaceState(
      {},
      '',
      `/genomes/${mockAssemblyName}?view=1&ref=UNKNOWN_CONTIG&center=4321&zoom=0.25&rev=0&tracks=sequence:120`,
    );
    render(<PortalJBrowseViewer assembly={assembly(true)} />);

    await waitFor(() => expect(stateTree.session.view.navToLocString).toHaveBeenCalledTimes(2));
    expect(stateTree.session.view.navToLocString.mock.calls).toEqual([
      ['UNKNOWN_CONTIG:4321', mockAssemblyName],
      [`${mockAssemblyName}:1-10000`, mockAssemblyName],
    ]);
    expect(stateTree.session.view.zoomTo).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/shared reference location.*default view/i);
  });

  it('falls back when JBrowse clamps a valid ref to a different center', async () => {
    const stateTree = makeStateTree();
    stateTree.session.view.pxToBp.mockReturnValue({
      assemblyName: mockAssemblyName,
      refName: mockAssemblyName,
      coord: 10000,
      index: 0,
      oob: false,
      offset: 0,
      start: 0,
      end: 10000,
      reversed: false,
    });
    vi.mocked(createViewState).mockReturnValue(stateTree as never);
    window.history.replaceState(
      {},
      '',
      `/genomes/${mockAssemblyName}?view=1&ref=${mockAssemblyName}&center=99999&zoom=0.25&rev=0&tracks=sequence:120`,
    );

    render(<PortalJBrowseViewer assembly={assembly(true)} />);

    await waitFor(() => expect(stateTree.session.view.navToLocString).toHaveBeenCalledTimes(2));
    expect(stateTree.session.view.navToLocString.mock.calls).toEqual([
      [`${mockAssemblyName}:99999`, mockAssemblyName],
      [`${mockAssemblyName}:1-10000`, mockAssemblyName],
    ]);
    expect(await screen.findByRole('status')).toHaveTextContent(/center coordinate.*default view/i);
  });

  it('disables sharing and exposes the multi-region reason', async () => {
    const stateTree = makeStateTree();
    stateTree.session.view.displayedRegions.push({
      assemblyName: mockAssemblyName,
      refName: mockAssemblyName,
      start: 20000,
      end: 30000,
      reversed: false,
    });
    vi.mocked(createViewState).mockReturnValue(stateTree as never);

    render(<PortalJBrowseViewer assembly={assembly(true)} />);

    const shareButton = screen.getByRole('button', { name: 'Share current view' });
    await waitFor(() => expect(shareButton).toBeDisabled());
    expect(shareButton).toHaveAttribute('aria-describedby', 'browser-share-unavailable');
    expect(screen.getByText(/multiple reference regions/i)).toBeInTheDocument();
  });
});
