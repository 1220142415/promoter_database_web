// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConf: vi.fn(),
  getContainingTrack: vi.fn(() => ({ id: 'track' })),
  getContainingView: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@jbrowse/core/configuration', () => ({ getConf: mocks.getConf }));
vi.mock('@jbrowse/core/util', () => ({
  getContainingTrack: mocks.getContainingTrack,
  getContainingView: mocks.getContainingView,
  getSession: mocks.getSession,
}));

import SeqEdgeTrackDownloadPlugin from '@/jbrowse/track-download-plugin';

describe('SeqEdge JBrowse track download plugin', () => {
  it('extends supported displays and adds a download action only to marked tracks', () => {
    let extension: ((element: { name: string; stateModel: { extend: (callback: (self: unknown) => unknown) => unknown } }) => unknown) | undefined;
    const pluginManager = {
      addToExtensionPoint: vi.fn((_name: string, callback: typeof extension) => { extension = callback; }),
    };
    new SeqEdgeTrackDownloadPlugin().install(pluginManager as never);
    expect(pluginManager.addToExtensionPoint).toHaveBeenCalledWith('Core-extendPluggableElement', expect.any(Function));

    let extender: ((self: unknown) => { views: { trackMenuItems: () => Array<{ label?: string; onClick?: () => void }> } }) | undefined;
    const extendedModel = {};
    const extend = vi.fn((callback: typeof extender) => {
      extender = callback;
      return extendedModel;
    });
    const display = {
      name: 'LinearBasicDisplay',
      stateModel: { extend },
    };
    expect(extension?.(display as never)).toMatchObject({ stateModel: extendedModel });
    expect(extend).toHaveBeenCalledOnce();

    const queueDialog = vi.fn();
    mocks.getSession.mockReturnValue({ queueDialog });
    mocks.getContainingView.mockReturnValue({
      width: 100,
      pxToBp: (px: number) => ({ refName: 'contig_1', coord: px + 1 }),
    });
    mocks.getConf.mockReturnValue({
      seqEdgeDownload: {
        kind: 'promoters',
        accession: 'GCA_000411415.1',
        label: 'RAPPtor predicted promoter peaks',
        regionExportBase: '/api/local-region',
        wholeAssetUrl: '/api/local-data/GCA_000411415.1/predicted-promoters.gff3.gz',
      },
    });
    const extensionViews = extender?.({ trackMenuItems: () => [{ label: 'Existing action' }] });
    const items = extensionViews?.views.trackMenuItems() || [];
    expect(items.map((item) => item.label)).toEqual(['Existing action', 'Download track data']);
    items[1].onClick?.();
    expect(queueDialog).toHaveBeenCalledOnce();

    mocks.getConf.mockReturnValue({});
    expect(extensionViews?.views.trackMenuItems().map((item) => item.label)).toEqual(['Existing action']);
  });

  it('leaves unrelated display types unchanged', () => {
    let extension: ((element: { name: string; stateModel: unknown }) => unknown) | undefined;
    const pluginManager = {
      addToExtensionPoint: vi.fn((_name: string, callback: typeof extension) => { extension = callback; }),
    };
    new SeqEdgeTrackDownloadPlugin().install(pluginManager as never);
    const element = { name: 'LinearWiggleDisplay', stateModel: {} };
    expect(extension?.(element)).toBe(element);
  });
});
