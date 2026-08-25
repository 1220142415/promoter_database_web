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

import RapptorTrackDownloadPlugin from '@/features/genome-browser/plugins/track-download-plugin';

describe('RAPPTOR JBrowse track download plugin', () => {
  it('extends supported displays and adds a download action only to marked tracks', () => {
    let extension: ((element: { name: string; stateModel: { extend: (callback: (self: unknown) => unknown) => unknown } }) => unknown) | undefined;
    const pluginManager = {
      addToExtensionPoint: vi.fn((_name: string, callback: typeof extension) => { extension = callback; }),
    };
    new RapptorTrackDownloadPlugin().install(pluginManager as never);
    expect(pluginManager.addToExtensionPoint).toHaveBeenCalledWith('Core-extendPluggableElement', expect.any(Function));

    type MenuItem = {
      label?: string;
      onClick?: () => void;
      subMenu?: Array<{ label?: string; onClick?: () => void }>;
    };
    let extender: ((self: unknown) => { views: { trackMenuItems: () => MenuItem[] } }) | undefined;
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
      rapptorDownload: {
        kind: 'promoters',
        accession: 'GCA_000411415.1',
        label: 'RAPPTOR predicted promoter peaks',
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

    const multiDisplay = {
      name: 'MultiLinearWiggleDisplay',
      stateModel: { extend },
    };
    extension?.(multiDisplay as never);
    const multiViews = extender?.({ trackMenuItems: () => [{ label: 'Existing action' }] });
    mocks.getConf.mockReturnValue({
      rapptorDownloads: [
        {
          kind: 'scores-plus',
          accession: 'GCA_000411415.1',
          label: 'RAPPTOR raw scores (+ strand)',
          regionExportBase: '',
          wholeAssetUrl: '/api/local-data/GCA_000411415.1/promoter-scores.plus.bw',
          visibleRegionDownload: false,
        },
        {
          kind: 'scores-minus',
          accession: 'GCA_000411415.1',
          label: 'RAPPTOR raw scores (- strand)',
          regionExportBase: '',
          wholeAssetUrl: '/api/local-data/GCA_000411415.1/promoter-scores.minus.bw',
          visibleRegionDownload: false,
        },
      ],
    });
    const multiItems = multiViews?.views.trackMenuItems() || [];
    expect(multiItems[1].subMenu?.map((item) => item.label)).toEqual([
      'Plus strand BigWig',
      'Minus strand BigWig',
    ]);
    multiItems[1].subMenu?.[1].onClick?.();
    expect(queueDialog).toHaveBeenCalledTimes(2);
    const dialogFactory = queueDialog.mock.calls[1][0] as (done: () => void) => [unknown, { metadata: { kind: string }; visibleRegion: unknown }];
    const [, dialogProps] = dialogFactory(vi.fn());
    expect(dialogProps.metadata.kind).toBe('scores-minus');
    expect(dialogProps.visibleRegion).toBeNull();
  });

  it('leaves unrelated display types unchanged', () => {
    let extension: ((element: { name: string; stateModel: unknown }) => unknown) | undefined;
    const pluginManager = {
      addToExtensionPoint: vi.fn((_name: string, callback: typeof extension) => { extension = callback; }),
    };
    new RapptorTrackDownloadPlugin().install(pluginManager as never);
    const element = { name: 'LinearPileupDisplay', stateModel: {} };
    expect(extension?.(element)).toBe(element);
  });
});
