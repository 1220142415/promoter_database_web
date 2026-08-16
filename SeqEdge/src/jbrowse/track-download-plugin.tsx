import Plugin from '@jbrowse/core/Plugin';
import type PluginManager from '@jbrowse/core/PluginManager';
import { getConf } from '@jbrowse/core/configuration';
import type { DisplayType, PluggableElementType } from '@jbrowse/core/pluggableElementTypes';
import { getContainingTrack, getContainingView, getSession } from '@jbrowse/core/util';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import TrackDownloadDialog, { type TrackDownloadDialogProps } from '@/components/track-download-dialog';
import {
  isTrackDownloadMetadata,
  visibleTrackRegion,
  type LinearViewLike,
} from '@/lib/track-download';

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

type DialogSession = {
  queueDialog: (
    callback: (doneCallback: () => void) => [typeof TrackDownloadDialog, TrackDownloadDialogProps],
  ) => void;
};

const DOWNLOADABLE_DISPLAYS = new Set([
  'LinearBasicDisplay',
  'LinearReferenceSequenceDisplay',
]);

export default class SeqEdgeTrackDownloadPlugin extends Plugin {
  name = 'SeqEdgeTrackDownloadPlugin';

  install(pluginManager: PluginManager) {
    pluginManager.addToExtensionPoint<PluggableElementType>('Core-extendPluggableElement', (element) => {
      if (!DOWNLOADABLE_DISPLAYS.has(element.name)) return element;
      const displayType = element as DisplayType;
      displayType.stateModel = displayType.stateModel.extend((self) => {
        const { trackMenuItems: superTrackMenuItems } = self as unknown as DownloadableDisplay;
        return {
          views: {
            trackMenuItems() {
              const items = superTrackMenuItems();
              const track = getContainingTrack(self);
              const trackMetadata = getConf(track, 'metadata') as { seqEdgeDownload?: unknown };
              const metadata = trackMetadata.seqEdgeDownload;
              if (!isTrackDownloadMetadata(metadata)) return items;

              return [
                ...items,
                {
                  label: 'Download track data',
                  icon: DownloadRoundedIcon,
                  priority: 50,
                  onClick: () => {
                    const view = getContainingView(self) as unknown as LinearViewLike;
                    const session = getSession(self) as unknown as DialogSession;
                    const visibleRegion = metadata.visibleRegionDownload === false ? null : visibleTrackRegion(view);
                    session.queueDialog((doneCallback) => [
                      TrackDownloadDialog,
                      { handleClose: doneCallback, metadata, visibleRegion },
                    ]);
                  },
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
