'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createViewState, JBrowseLinearGenomeView } from '@jbrowse/react-linear-genome-view';
import ShareRoundedIcon from '@mui/icons-material/ShareRounded';
import SeqEdgeMirroredScorePlugin from '@/jbrowse/mirrored-score-plugin';
import SeqEdgeStrandFeaturePlugin, {
  DIRECTIONAL_ANNOTATION_RENDERER,
  PROMOTER_FEATURE_RENDERER,
} from '@/jbrowse/strand-feature-plugin';
import SeqEdgeTrackDownloadPlugin from '@/jbrowse/track-download-plugin';
import {
  buildJBrowseShareUrl,
  extractJBrowseShareState,
  parseJBrowseShareParams,
  type ShareTrackRegistry,
  type ShareTrackToken,
} from '@/lib/jbrowse-share';
import { visibleTrackRegion, type TrackDownloadMetadata } from '@/lib/track-download';
import type { JBrowseReleaseAssembly } from '@/types/release';

export interface BrowserRegion {
  refName: string;
  start: number;
  end: number;
}

type SessionTrackSnapshot = {
  type: string;
  configuration: string;
  displays: Array<{
    type: string;
    configuration: string;
    heightPreConfig: number;
  }>;
};

type SessionTrackDefinition = {
  token: ShareTrackToken;
  snapshot: SessionTrackSnapshot;
};

type ShareFeedback = {
  message: string;
  manualUrl?: string;
};

function resolveAsset(base: string, path: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('/')) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export default function PortalJBrowseViewer({ assembly, onRegionChange }: { assembly: JBrowseReleaseAssembly; onRegionChange?: (region: BrowserRegion) => void }) {
  const [shareAvailable, setShareAvailable] = useState(false);
  const [shareUnavailableReason, setShareUnavailableReason] = useState(
    'Sharing is available for a single reference sequence after the browser loads.',
  );
  const [restoreMessage, setRestoreMessage] = useState('');
  const [shareFeedback, setShareFeedback] = useState<ShareFeedback | null>(null);
  const initializationPromises = useRef(new WeakMap<object, Promise<string[]>>());
  const parsedShare = useMemo(
    () => parseJBrowseShareParams(new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)),
    [],
  );

  const { viewState, trackRegistry, initialWarnings } = useMemo(() => {
    const unindexed = assembly.adapterMode === 'unindexed';
    const regionExportBase = assembly.regionExportBase || '';
    const downloadMetadata = (
      kind: TrackDownloadMetadata['kind'],
      label: string,
      wholeAssetUrl: string,
      visibleRegionDownload = unindexed || Boolean(regionExportBase),
    ): { seqEdgeDownload: TrackDownloadMetadata } => ({
      seqEdgeDownload: {
        kind,
        accession: assembly.assemblyName,
        label,
        regionExportBase,
        wholeAssetUrl,
        downloadMode: unindexed ? 'browser' : 'remote',
        visibleRegionDownload,
      },
    });
    const predictedTrackId = `${assembly.assemblyName}-predicted-promoters`;
    const tracks: Array<Record<string, unknown>> = [];
    const trackTokens = new Map<string, ShareTrackToken>();
    if (assembly.assets.promoterScoresPlus && assembly.assets.promoterScoresMinus) {
      const trackId = `${assembly.assemblyName}-promoter-scores`;
      trackTokens.set(trackId, 'scores');
      const plusUrl = resolveAsset(assembly.assetBase, assembly.assets.promoterScoresPlus);
      const minusUrl = resolveAsset(assembly.assetBase, assembly.assets.promoterScoresMinus);
      tracks.push({
        trackId,
        name: 'RAPPtor raw scores (+ / - strands)',
        metadata: {
          seqEdgeMirroredScore: true,
          seqEdgeDownloads: [
            downloadMetadata('scores-plus', 'RAPPtor raw scores (+ strand)', plusUrl, false).seqEdgeDownload,
            downloadMetadata('scores-minus', 'RAPPtor raw scores (- strand)', minusUrl, false).seqEdgeDownload,
          ],
        },
        assemblyNames: [assembly.assemblyName],
        type: 'MultiQuantitativeTrack',
        adapter: {
          type: 'MultiWiggleAdapter',
          subadapters: [
            { type: 'BigWigAdapter', source: 'plus', name: '+ strand', bigWigLocation: { uri: plusUrl } },
            { type: 'BigWigAdapter', source: 'minus', name: '- strand', bigWigLocation: { uri: minusUrl } },
          ],
        },
        displays: [{
          displayId: `${trackId}-display`,
          type: 'MultiLinearWiggleDisplay',
          defaultRendering: 'xyplot',
          autoscale: 'local',
          minScore: 0,
          maxScore: 1,
          renderers: {
            MultiXYPlotRenderer: { summaryScoreMode: 'max' },
            MultiLineRenderer: { summaryScoreMode: 'max' },
          },
        }],
      });
    }
    trackTokens.set(predictedTrackId, 'promoters');
    tracks.push({
        trackId: predictedTrackId,
        name: 'RAPPtor predicted promoters',
        metadata: {
          ...downloadMetadata(
            'promoters',
            'RAPPtor predicted promoters',
            resolveAsset(assembly.assetBase, assembly.assets.predictedPromoters),
          ),
          seqEdgeStrandFeatureMode: 'promoter',
        },
        assemblyNames: [assembly.assemblyName],
        type: 'FeatureTrack',
        adapter: {
          ...(unindexed
            ? {
                type: 'Gff3Adapter',
                gffLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.predictedPromoters) },
              }
            : {
                type: 'Gff3TabixAdapter',
                gffGzLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.predictedPromoters) },
                index: {
                  indexType: 'TBI',
                  location: { uri: resolveAsset(assembly.assetBase, assembly.assets.predictedPromotersIndex) },
                },
              }),
        },
        displays: [{
          displayId: `${predictedTrackId}-display`,
          type: 'LinearBasicDisplay',
          renderer: {
            type: PROMOTER_FEATURE_RENDERER,
            height: 18,
            showLabels: false,
            showDescriptions: false,
            maxFeatureGlyphExpansion: 24,
          },
        }],
      });

    if (assembly.assets.ncbiAnnotations && (unindexed || assembly.assets.ncbiAnnotationsIndex)) {
      const ncbiTrackId = `${assembly.assemblyName}-ncbi-annotations`;
      trackTokens.set(ncbiTrackId, 'annotation');
      tracks.push({
        trackId: ncbiTrackId,
        name: 'NCBI genome annotation',
        metadata: {
          ...downloadMetadata(
            'ncbi',
            'NCBI genome annotation',
            resolveAsset(assembly.assetBase, assembly.assets.ncbiAnnotations),
          ),
          seqEdgeStrandFeatureMode: 'annotation',
        },
        assemblyNames: [assembly.assemblyName],
        type: 'FeatureTrack',
        adapter: {
          ...(unindexed
            ? {
                type: 'Gff3Adapter',
                gffLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.ncbiAnnotations) },
              }
            : {
                type: 'Gff3TabixAdapter',
                gffGzLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.ncbiAnnotations) },
                index: {
                  indexType: 'TBI',
                  location: { uri: resolveAsset(assembly.assetBase, assembly.assets.ncbiAnnotationsIndex!) },
                },
              }),
        },
        displays: [{
          displayId: `${ncbiTrackId}-display`,
          type: 'LinearBasicDisplay',
          renderer: {
            type: DIRECTIONAL_ANNOTATION_RENDERER,
            height: 10,
          },
        }],
      });
    }

    const sequenceTrackId = `${assembly.assemblyName}-reference-sequence`;
    const sessionTrackDefinitions: SessionTrackDefinition[] = [
      {
        token: 'sequence',
        snapshot: {
          type: 'ReferenceSequenceTrack',
          configuration: sequenceTrackId,
          displays: [{
            type: 'LinearReferenceSequenceDisplay',
            configuration: `${sequenceTrackId}-LinearReferenceSequenceDisplay`,
            heightPreConfig: 120,
          }],
        },
      },
      ...tracks.map((track) => ({
        token: trackTokens.get(String(track.trackId))!,
        snapshot: {
          type: String(track.type),
          configuration: String(track.trackId),
          displays: (track.displays as Array<{ displayId: string; type: string }>).map((display) => ({
            type: display.type,
            configuration: display.displayId,
            heightPreConfig: display.type === 'MultiLinearWiggleDisplay' ? 180 : 170,
          })),
        },
      })),
    ];
    const definitionsByToken = new Map(sessionTrackDefinitions.map((definition) => [definition.token, definition]));
    const trackRegistry = Object.fromEntries(
      sessionTrackDefinitions.map((definition) => [definition.token, definition.snapshot.configuration]),
    ) as ShareTrackRegistry;
    const initialWarnings = parsedShare.kind === 'absent' ? [] : [...parsedShare.warnings];
    if (parsedShare.kind === 'invalid') {
      initialWarnings.unshift('This shared view link is invalid. The genome default view is shown instead.');
    }
    const requestedTracks = parsedShare.kind === 'valid' ? parsedShare.state.tracks : null;
    const sessionTracks = requestedTracks === null
      ? sessionTrackDefinitions.map((definition) => definition.snapshot)
      : requestedTracks.flatMap(({ token, height }) => {
          const definition = definitionsByToken.get(token);
          if (!definition) {
            initialWarnings.push(`The ${token} track is not available in this release.`);
            return [];
          }
          return [{
            ...definition.snapshot,
            displays: definition.snapshot.displays.map((display, index) => ({
              ...display,
              heightPreConfig: index === 0 ? height : display.heightPreConfig,
            })),
          }];
        });

    const stateTree = createViewState({
      assembly: {
        name: assembly.assemblyName,
        sequence: {
          type: 'ReferenceSequenceTrack',
          trackId: sequenceTrackId,
          name: 'Reference sequence',
          metadata: downloadMetadata(
            'reference',
            'Reference sequence',
            resolveAsset(assembly.assetBase, assembly.assets.fasta),
          ),
          adapter: {
            ...(unindexed
              ? {
                  type: 'UnindexedFastaAdapter',
                  fastaLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.fasta) },
                }
              : {
                  type: 'BgzipFastaAdapter',
                  fastaLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.fasta) },
                  faiLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.fastaFai) },
                  gziLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.fastaGzi) },
                }),
          },
        },
      },
      tracks,
      plugins: [SeqEdgeMirroredScorePlugin, SeqEdgeStrandFeaturePlugin, SeqEdgeTrackDownloadPlugin],
      defaultSession: {
        name: `${assembly.assemblyName} release view`,
        view: {
          id: `${assembly.assemblyName}-linear-view`,
          type: 'LinearGenomeView',
          tracks: sessionTracks,
        },
      },
      onChange: () => {
        const view = stateTree?.session.view;
        if (!view || !view.initialized || view.width <= 0) return;
        const extracted = extractJBrowseShareState(view, trackRegistry);
        setShareAvailable(extracted.kind === 'valid');
        setShareUnavailableReason(extracted.kind === 'invalid' ? extracted.warnings.join(' ') : '');
        if (onRegionChange) {
          const region = visibleTrackRegion(view);
          if (region) onRegionChange(region);
        }
      },
    });
    return { viewState: stateTree, trackRegistry, initialWarnings };
  }, [assembly, onRegionChange, parsedShare]);

  useEffect(() => {
    setShareFeedback(null);
    setShareAvailable(false);
    setShareUnavailableReason('Sharing is available for a single reference sequence after the browser loads.');
    let initialization = initializationPromises.current.get(viewState);
    if (!initialization) {
      initialization = (async () => {
        const warnings = [...initialWarnings];
        const view = viewState.session.view;
        const sharedState = parsedShare.kind === 'valid' ? parsedShare.state : null;
        const initialLocation = sharedState
          ? `${sharedState.refName}:${sharedState.center}${sharedState.reversed ? '[rev]' : ''}`
          : assembly.defaultLocus;
        try {
          await view.navToLocString(initialLocation, assembly.assemblyName);
          if (sharedState) {
            const appliedZoom = view.zoomTo(sharedState.bpPerPx, view.width / 2);
            const actualZoom = Number.isFinite(appliedZoom) ? appliedZoom : view.bpPerPx;
            const tolerance = Math.max(1e-9, sharedState.bpPerPx * 1e-6);
            if (Math.abs(actualZoom - sharedState.bpPerPx) > tolerance) {
              warnings.push('This device cannot reproduce the exact shared zoom level; the nearest supported zoom is shown.');
            }
            const restoredCenter = view.pxToBp(view.width / 2);
            const centerMatches = !restoredCenter.oob
              && restoredCenter.refName === sharedState.refName
              && Number.isSafeInteger(restoredCenter.coord)
              && Math.abs(restoredCenter.coord - sharedState.center) <= 1
              && (restoredCenter.reversed === true) === sharedState.reversed;
            if (!centerMatches) {
              warnings.push('The shared center coordinate or orientation is unavailable in this release. The genome default view is shown instead.');
              await view.navToLocString(assembly.defaultLocus, assembly.assemblyName);
            }
          }
        } catch {
          if (sharedState) {
            warnings.push('The shared reference location is unavailable in this release. The genome default view is shown instead.');
            try {
              await view.navToLocString(assembly.defaultLocus, assembly.assemblyName);
            } catch {
              warnings.push('The genome default location could not be opened.');
            }
          } else {
            warnings.push('The genome default location could not be opened.');
          }
        }
        return warnings;
      })();
      initializationPromises.current.set(viewState, initialization);
    }

    let active = true;
    void initialization.then((warnings) => {
      if (!active) return;
      setRestoreMessage(warnings.join(' '));
      const extracted = extractJBrowseShareState(viewState.session.view, trackRegistry);
      setShareAvailable(extracted.kind === 'valid');
      setShareUnavailableReason(extracted.kind === 'invalid' ? extracted.warnings.join(' ') : '');
    });
    return () => {
      active = false;
    };
  }, [assembly.assemblyName, assembly.defaultLocus, initialWarnings, parsedShare, trackRegistry, viewState]);

  const handleShare = async () => {
    const extracted = extractJBrowseShareState(viewState.session.view, trackRegistry);
    if (extracted.kind === 'invalid') {
      setShareAvailable(false);
      setShareUnavailableReason(extracted.warnings.join(' '));
      setShareFeedback({ message: extracted.warnings.join(' ') || 'This view cannot be shared.' });
      return;
    }

    const url = buildJBrowseShareUrl(window.location, extracted.state);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(url);
      setShareFeedback({ message: 'Link copied' });
    } catch {
      setShareFeedback({
        message: 'Clipboard access is unavailable. Copy the link manually.',
        manualUrl: url,
      });
    }
  };

  return (
    <div className="portal-browser" data-testid="jbrowse-viewer">
      <div className="browser-share-toolbar">
        <div className="browser-share-copy">
          <strong>Share this genome view</strong>
          <span>Position, zoom, direction and built-in track layout</span>
        </div>
        <button
          type="button"
          className="browser-share-button"
          onClick={() => void handleShare()}
          disabled={!shareAvailable}
          aria-describedby={!shareAvailable ? 'browser-share-unavailable' : undefined}
          title={shareAvailable ? 'Copy a link to the current genome view' : shareUnavailableReason}
        >
          <ShareRoundedIcon aria-hidden="true" />
          Share current view
        </button>
      </div>
      {restoreMessage && <p className="browser-share-notice" role="status">{restoreMessage}</p>}
      <div className="browser-share-feedback" aria-live="polite">
        {!shareAvailable && shareUnavailableReason && (
          <span id="browser-share-unavailable">{shareUnavailableReason}</span>
        )}
        {shareFeedback?.message && <span>{shareFeedback.message}</span>}
        {shareFeedback?.manualUrl && (
          <label>
            <span>Share link</span>
            <input
              aria-label="Share link"
              readOnly
              value={shareFeedback.manualUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        )}
      </div>
      <JBrowseLinearGenomeView viewState={viewState} />
    </div>
  );
}
