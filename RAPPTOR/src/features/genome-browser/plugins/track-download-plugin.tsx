import Plugin from '@jbrowse/core/Plugin';
import type PluginManager from '@jbrowse/core/PluginManager';
import { getConf } from '@jbrowse/core/configuration';
import type { DisplayType, PluggableElementType, TrackType } from '@jbrowse/core/pluggableElementTypes';
import { getContainingTrack, getContainingView, getSession } from '@jbrowse/core/util';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import TrackDownloadDialog, { type TrackDownloadDialogProps } from '@/features/genome-browser/components/track-download-dialog';
import {
  isTrackDownloadMetadata,
  visibleTrackRegion,
  type LinearViewLike,
} from '@/features/genome-browser/track-download';

type TrackMenuItem = {
  label?: string;
  priority?: number;
  icon?: typeof DownloadRoundedIcon;
  onClick?: () => void;
  [key: string]: unknown;
};

type DownloadableDisplay = {
  trackMenuItems: () => TrackMenuItem[];
};

type TrackMetadata = {
  rapptorDownload?: unknown;
  rapptorDownloads?: unknown;
  rapptorExperimentalDownloads?: unknown;
};

type ExperimentalBedDownload = { kind: 'raw-bed'; label: string; url: string };

type DialogSession = {
  queueDialog: (
    callback: (doneCallback: () => void) => [typeof TrackDownloadDialog, TrackDownloadDialogProps],
  ) => void;
};

const DOWNLOADABLE_DISPLAYS = new Set([
  'LinearBasicDisplay',
  'LinearReferenceSequenceDisplay',
  'LinearWiggleDisplay',
  'MultiLinearWiggleDisplay',
]);

function experimentalBedDownload(metadata: TrackMetadata) {
  const downloads = Array.isArray(metadata.rapptorExperimentalDownloads)
    ? metadata.rapptorExperimentalDownloads
    : [];
  return downloads.find((value): value is ExperimentalBedDownload => {
    if (!value || typeof value !== 'object') return false;
    const download = value as Partial<ExperimentalBedDownload>;
    return download.kind === 'raw-bed'
      && typeof download.label === 'string'
      && typeof download.url === 'string'
      && download.url.startsWith('/api/experimental-data/');
  });
}

function downloadBed(url: string) {
  const anchor = document.createElement('a');
  anchor.href = `${url}${url.includes('?') ? '&' : '?'}download=1`;
  anchor.download = '';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export default class RapptorTrackDownloadPlugin extends Plugin {
  name = 'RAPPTORTrackDownloadPlugin';

  install(pluginManager: PluginManager) {
    pluginManager.addToExtensionPoint<PluggableElementType>('Core-extendPluggableElement', (element) => {
      if (element.name.endsWith('Track')) {
        const trackType = element as TrackType;
        trackType.stateModel = trackType.stateModel.extend((self) => {
          const { trackMenuItems: superTrackMenuItems } = self as unknown as DownloadableDisplay;
          return {
            views: {
              trackMenuItems() {
                const metadata = getConf(self, 'metadata') as TrackMetadata;
                const items = superTrackMenuItems().filter((item) => item.label !== 'Display types');
                const bedDownload = experimentalBedDownload(metadata);
                return bedDownload
                  ? [...items, { label: 'Download original BED', icon: DownloadRoundedIcon, priority: 50, onClick: () => downloadBed(bedDownload.url) }]
                  : items;
              },
            },
          };
        });
        return trackType;
      }
      if (!DOWNLOADABLE_DISPLAYS.has(element.name)) return element;
      const displayType = element as DisplayType;
      displayType.stateModel = displayType.stateModel.extend((self) => {
        const { trackMenuItems: superTrackMenuItems } = self as unknown as DownloadableDisplay;
        return {
          views: {
            trackMenuItems() {
              const items = superTrackMenuItems();
              const track = getContainingTrack(self);
              const trackMetadata = getConf(track, 'metadata') as TrackMetadata;
              const downloads = Array.isArray(trackMetadata.rapptorDownloads)
                ? trackMetadata.rapptorDownloads.filter(isTrackDownloadMetadata)
                : isTrackDownloadMetadata(trackMetadata.rapptorDownload)
                  ? [trackMetadata.rapptorDownload]
                  : [];
              if (!downloads.length) return items;

              const openDialog = (metadata: (typeof downloads)[number]) => {
                const view = getContainingView(self) as unknown as LinearViewLike;
                const session = getSession(self) as unknown as DialogSession;
                const visibleRegion = metadata.visibleRegionDownload === false ? null : visibleTrackRegion(view);
                session.queueDialog((doneCallback) => [
                  TrackDownloadDialog,
                  { handleClose: doneCallback, metadata, visibleRegion },
                ]);
              };

              return [
                ...items,
                {
                  label: 'Download track data',
                  icon: DownloadRoundedIcon,
                  priority: 50,
                  ...(downloads.length === 1
                    ? { onClick: () => openDialog(downloads[0]) }
                    : {
                        subMenu: downloads.map((metadata) => ({
                          label: metadata.kind === 'scores-plus' ? 'Plus strand BigWig' : 'Minus strand BigWig',
                          onClick: () => openDialog(metadata),
                        })),
                      }),
                },
              ];
            },
          },
        };
      });
      return displayType;
    });
  }
}
