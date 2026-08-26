'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createViewState } from '@jbrowse/react-linear-genome-view';
import ShareRoundedIcon from '@mui/icons-material/ShareRounded';
import RapptorJBrowseLinearView from '@/features/genome-browser/components/rapptor-jbrowse-linear-view';
import RapptorExperimentalTssPlugin, { EXPERIMENTAL_TSS_RENDERER } from '@/features/genome-browser/plugins/experimental-tss-plugin';
import RapptorMirroredScorePlugin from '@/features/genome-browser/plugins/mirrored-score-plugin';
import RapptorStrandFeaturePlugin, {
  DIRECTIONAL_ANNOTATION_RENDERER,
  PROMOTER_FEATURE_RENDERER,
} from '@/features/genome-browser/plugins/strand-feature-plugin';
import RapptorTrackDownloadPlugin from '@/features/genome-browser/plugins/track-download-plugin';
import {
  buildJBrowseShareUrl,
  extractJBrowseShareState,
  parseJBrowseShareParams,
  studyShareTrackToken,
  type ShareTrackRegistry,
  type ShareTrackToken,
} from '@/features/genome-browser/jbrowse-share';
import { visibleTrackRegion, type TrackDownloadMetadata } from '@/features/genome-browser/track-download';
import type { ExperimentalTssGenome, ExperimentalTssStudy } from '@/types/experimental-tss';
import type { JBrowseReleaseAssembly } from '@/types/release';
import type { BrowserRegion } from '@/features/genome-browser/components/portal-jbrowse-viewer';

type SessionTrackSnapshot = {
  type: string;
  configuration: string;
  displays: Array<{ type: string; configuration: string; heightPreConfig: number }>;
};

type SessionTrackDefinition = { token: ShareTrackToken; snapshot: SessionTrackSnapshot };
type ShareFeedback = { message: string; manualUrl?: string };
type JBrowseFailureState = { referenceFailed: boolean; optionalTrackLabels: string[] };

export interface UnifiedJBrowseViewerProps {
  prediction?: JBrowseReleaseAssembly | null;
  experimental?: ExperimentalTssGenome | null;
  onRegionChange?: (region: BrowserRegion) => void;
}

function resolveAsset(base: string, path: string) {
  if (/^[a-z][a-z\d+.-]*:/iu.test(path) || path.startsWith('/')) return path;
  return `${base.replace(/\/+$/u, '')}/${path.replace(/^\/+/, '')}`;
}

function sortedStudies(studies: readonly ExperimentalTssStudy[]) {
  return [...studies].sort((left, right) => left.year - right.year
    || left.pmid.localeCompare(right.pmid)
    || left.studyId.localeCompare(right.studyId));
}

function modelHasError(model: unknown) {
  if (!model || typeof model !== 'object') return false;
  const candidate = model as {
    error?: unknown;
    blockState?: { values?: () => Iterable<{ error?: unknown }> };
  };
  if (candidate.error) return true;
  try {
    return [...(candidate.blockState?.values?.() || [])].some((block) => Boolean(block.error));
  } catch {
    return false;
  }
}

function trackConfigurationId(track: unknown) {
  if (!track || typeof track !== 'object') return '';
  const configuration = (track as { configuration?: unknown }).configuration;
  if (typeof configuration === 'string') return configuration;
  if (!configuration || typeof configuration !== 'object') return '';
  const candidate = configuration as { trackId?: unknown; configuration?: { trackId?: unknown } };
  return typeof candidate.trackId === 'string'
    ? candidate.trackId
    : typeof candidate.configuration?.trackId === 'string' ? candidate.configuration.trackId : '';
}

export function inspectUnifiedJBrowseFailures(
  stateTree: unknown,
  assemblyName: string,
  sequenceTrackId: string,
  trackLabels: ReadonlyMap<string, string>,
): JBrowseFailureState {
  const tree = stateTree as {
    error?: unknown;
    assemblyManager?: { get?: (name: string) => unknown };
    session?: {
      assemblyManager?: { get?: (name: string) => unknown };
      view?: { error?: unknown; tracks?: unknown[] };
    };
  };
  const assembly = tree.assemblyManager?.get?.(assemblyName)
    || tree.session?.assemblyManager?.get?.(assemblyName);
  let referenceFailed = Boolean(tree.error || tree.session?.view?.error || modelHasError(assembly));
  const optionalTrackLabels: string[] = [];
  for (const track of tree.session?.view?.tracks || []) {
    const displays = (track as { displays?: unknown[] }).displays || [];
    if (!modelHasError(track) && !displays.some(modelHasError)) continue;
    const configuration = trackConfigurationId(track);
    if (configuration === sequenceTrackId) referenceFailed = true;
    else optionalTrackLabels.push(trackLabels.get(configuration) || 'An optional evidence track');
  }
  return { referenceFailed, optionalTrackLabels: [...new Set(optionalTrackLabels)] };
}

export default function UnifiedJBrowseViewer({ prediction, experimental, onRegionChange }: UnifiedJBrowseViewerProps) {
  if (!prediction && !experimental) throw new Error('A prediction or experimental assembly is required.');

  const studies = useMemo(() => sortedStudies(experimental?.studies || []), [experimental?.studies]);
  const allowedStudyIds = useMemo(() => new Set(studies.map((study) => study.studyId)), [studies]);
  const assemblyName = prediction?.assemblyName || experimental?.assemblyName || experimental!.accession;
  const defaultLocus = experimental?.defaultLocus || prediction!.defaultLocus;
  const [shareAvailable, setShareAvailable] = useState(false);
  const [shareUnavailableReason, setShareUnavailableReason] = useState(
    'Sharing is available for a single reference sequence after the browser loads.',
  );
  const [restoreMessage, setRestoreMessage] = useState('');
  const [partialViewMessage, setPartialViewMessage] = useState('');
  const [referenceFailureMessage, setReferenceFailureMessage] = useState('');
  const [shareFeedback, setShareFeedback] = useState<ShareFeedback | null>(null);
  const initializationPromises = useRef(new WeakMap<object, Promise<string[]>>());
  const parsedShare = useMemo(
    () => parseJBrowseShareParams(
      new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search),
      allowedStudyIds,
    ),
    [allowedStudyIds],
  );

  const { viewState, trackRegistry, initialWarnings, trackLabels } = useMemo(() => {
    const predictionUnindexed = prediction?.adapterMode === 'unindexed';
    const sequenceTrackId = `${assemblyName}-reference-sequence`;
    const tracks: Array<Record<string, unknown>> = [];
    const definitions: SessionTrackDefinition[] = [{
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
    }];
    const staticRegistry: Partial<Record<'sequence' | 'scores' | 'promoters' | 'annotation', string>> = {
      sequence: sequenceTrackId,
    };
    const studyRegistry: Record<string, string> = {};
    const predictionDownload = (
      kind: TrackDownloadMetadata['kind'],
      label: string,
      wholeAssetUrl: string,
      visibleRegionDownload = Boolean(predictionUnindexed || prediction?.regionExportBase),
    ) => ({
      rapptorDownload: {
        kind,
        accession: prediction!.assemblyName,
        label,
        regionExportBase: prediction?.regionExportBase || '',
        wholeAssetUrl,
        downloadMode: predictionUnindexed ? 'browser' as const : 'remote' as const,
        visibleRegionDownload,
      },
    });

    if (prediction?.assets.promoterScoresPlus && prediction.assets.promoterScoresMinus) {
      const trackId = `${assemblyName}-promoter-scores`;
      const plusUrl = resolveAsset(prediction.assetBase, prediction.assets.promoterScoresPlus);
      const minusUrl = resolveAsset(prediction.assetBase, prediction.assets.promoterScoresMinus);
      staticRegistry.scores = trackId;
      tracks.push({
        trackId,
        name: 'RAPPTOR raw scores (+ / - strands)',
        metadata: {
          rapptorMirroredScore: true,
          rapptorDownloads: [
            predictionDownload('scores-plus', 'RAPPTOR raw scores (+ strand)', plusUrl, false).rapptorDownload,
            predictionDownload('scores-minus', 'RAPPTOR raw scores (- strand)', minusUrl, false).rapptorDownload,
          ],
        },
        assemblyNames: [assemblyName],
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
      definitions.push({
        token: 'scores',
        snapshot: {
          type: 'MultiQuantitativeTrack',
          configuration: trackId,
          displays: [{ type: 'MultiLinearWiggleDisplay', configuration: `${trackId}-display`, heightPreConfig: 180 }],
        },
      });
    }

    if (prediction) {
      const trackId = `${assemblyName}-predicted-promoters`;
      const dataUrl = resolveAsset(prediction.assetBase, prediction.assets.predictedPromoters);
      staticRegistry.promoters = trackId;
      tracks.push({
        trackId,
        name: 'RAPPTOR predicted promoters',
        metadata: {
          ...predictionDownload('promoters', 'RAPPTOR predicted promoters', dataUrl),
          rapptorEvidenceType: 'prediction',
          rapptorStrandFeatureMode: 'promoter',
        },
        assemblyNames: [assemblyName],
        type: 'FeatureTrack',
        adapter: predictionUnindexed
          ? { type: 'Gff3Adapter', gffLocation: { uri: dataUrl } }
          : {
              type: 'Gff3TabixAdapter',
              gffGzLocation: { uri: dataUrl },
              index: {
                indexType: 'TBI',
                location: { uri: resolveAsset(prediction.assetBase, prediction.assets.predictedPromotersIndex) },
              },
            },
        displays: [{
          displayId: `${trackId}-display`,
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
      definitions.push({
        token: 'promoters',
        snapshot: {
          type: 'FeatureTrack',
          configuration: trackId,
          displays: [{ type: 'LinearBasicDisplay', configuration: `${trackId}-display`, heightPreConfig: 170 }],
        },
      });
    }

    for (const study of studies) {
      const token = studyShareTrackToken(study.studyId);
      const trackId = `${assemblyName}-experimental-tss-${study.studyId}`;
      const dataUrl = resolveAsset(experimental!.assetBase, study.assets.data);
      studyRegistry[study.studyId] = trackId;
      tracks.push({
        trackId,
        name: `Experimental TSS · PMID ${study.pmid}`,
        description: study.publication.title || `${study.recordCount.toLocaleString('en-US')} original observations`,
        metadata: {
          rapptorEvidenceType: 'experimental_tss',
          rapptorStudy: {
            studyId: study.studyId,
            pmid: study.pmid,
            year: study.year,
            recordCount: study.recordCount,
            title: study.publication.title,
            journal: study.publication.journal,
          },
          rapptorExperimentalDownloads: [
            {
              kind: 'raw-bed',
              label: 'Original BED observations',
              url: resolveAsset(experimental!.assetBase, study.assets.rawBed),
              sourcePath: study.assets.rawBed,
            },
            {
              kind: 'normalized-gff3',
              label: 'Normalized experimental TSS GFF3',
              url: dataUrl,
              sourcePath: study.assets.data,
            },
          ],
        },
        assemblyNames: [assemblyName],
        type: 'FeatureTrack',
        adapter: study.assets.index
          ? {
              type: 'Gff3TabixAdapter',
              gffGzLocation: { uri: dataUrl },
              index: {
                indexType: 'TBI',
                location: { uri: resolveAsset(experimental!.assetBase, study.assets.index) },
              },
            }
          : { type: 'Gff3Adapter', gffLocation: { uri: dataUrl } },
        displays: [{
          displayId: `${trackId}-display`,
          type: 'LinearBasicDisplay',
          renderer: {
            type: EXPERIMENTAL_TSS_RENDERER,
            height: 18,
            showLabels: false,
            showDescriptions: false,
            maxFeatureGlyphExpansion: 24,
          },
        }],
      });
      definitions.push({
        token,
        snapshot: {
          type: 'FeatureTrack',
          configuration: trackId,
          displays: [{ type: 'LinearBasicDisplay', configuration: `${trackId}-display`, heightPreConfig: 170 }],
        },
      });
    }

    const predictionAnnotation = prediction?.assets.ncbiAnnotations
      && (predictionUnindexed || prediction.assets.ncbiAnnotationsIndex)
      ? {
          base: prediction.assetBase,
          data: prediction.assets.ncbiAnnotations,
          index: prediction.assets.ncbiAnnotationsIndex,
          unindexed: predictionUnindexed,
          accession: prediction.assemblyName,
        }
      : null;
    const experimentalAnnotation = !predictionAnnotation
      && experimental?.annotationStatus === 'available'
      && experimental.assets.ncbiAnnotations
      && experimental.assets.ncbiAnnotationsIndex
      ? {
          base: experimental.assetBase,
          data: experimental.assets.ncbiAnnotations,
          index: experimental.assets.ncbiAnnotationsIndex,
          unindexed: false,
          accession: experimental.accession,
        }
      : null;
    const annotation = predictionAnnotation || experimentalAnnotation;
    if (annotation) {
      const trackId = `${assemblyName}-ncbi-annotations`;
      const dataUrl = resolveAsset(annotation.base, annotation.data);
      staticRegistry.annotation = trackId;
      tracks.push({
        trackId,
        name: 'NCBI genome annotation',
        metadata: {
          ...(predictionAnnotation
            ? predictionDownload('ncbi', 'NCBI genome annotation', dataUrl)
            : {
                rapptorDownload: {
                  kind: 'ncbi',
                  accession: annotation.accession,
                  label: 'NCBI genome annotation',
                  regionExportBase: '',
                  wholeAssetUrl: dataUrl,
                  downloadMode: 'remote',
                  visibleRegionDownload: false,
                },
              }),
          rapptorStrandFeatureMode: 'annotation',
        },
        assemblyNames: [assemblyName],
        type: 'FeatureTrack',
        adapter: annotation.unindexed
          ? { type: 'Gff3Adapter', gffLocation: { uri: dataUrl } }
          : {
              type: 'Gff3TabixAdapter',
              gffGzLocation: { uri: dataUrl },
              index: { indexType: 'TBI', location: { uri: resolveAsset(annotation.base, annotation.index!) } },
            },
        displays: [{
          displayId: `${trackId}-display`,
          type: 'LinearBasicDisplay',
          renderer: { type: DIRECTIONAL_ANNOTATION_RENDERER, height: 10 },
        }],
      });
      definitions.push({
        token: 'annotation',
        snapshot: {
          type: 'FeatureTrack',
          configuration: trackId,
          displays: [{ type: 'LinearBasicDisplay', configuration: `${trackId}-display`, heightPreConfig: 170 }],
        },
      });
    }

    const registry: ShareTrackRegistry = { ...staticRegistry, studies: studyRegistry };
    const definitionsByToken = new Map(definitions.map((definition) => [definition.token, definition]));
    const initialWarnings = parsedShare.kind === 'absent' ? [] : [...parsedShare.warnings];
    if (parsedShare.kind === 'invalid') {
      initialWarnings.unshift('This shared view link is invalid. The genome default view is shown instead.');
    }
    const requestedTracks = parsedShare.kind === 'valid' ? parsedShare.state.tracks : null;
    const sessionTracks = requestedTracks === null
      ? definitions.map((definition) => definition.snapshot)
      : requestedTracks.flatMap(({ token, height }) => {
          const definition = definitionsByToken.get(token);
          if (!definition) {
            initialWarnings.push(`The ${token.replace('study:', 'study ')} track is not available for this genome.`);
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

    const referenceBase = prediction?.assetBase || experimental!.assetBase;
    const referenceAssets = prediction?.assets || experimental!.assets;
    const referenceAccession = prediction?.assemblyName || experimental!.accession;
    const referenceUrl = resolveAsset(referenceBase, referenceAssets.fasta);
    const stateTree = createViewState({
      assembly: {
        name: assemblyName,
        sequence: {
          type: 'ReferenceSequenceTrack',
          trackId: sequenceTrackId,
          name: 'Reference sequence',
          metadata: {
            rapptorDownload: prediction
              ? predictionDownload('reference', 'Reference sequence', referenceUrl).rapptorDownload
              : {
                  kind: 'reference',
                  accession: referenceAccession,
                  label: 'Reference sequence',
                  regionExportBase: '',
                  wholeAssetUrl: referenceUrl,
                  downloadMode: 'remote',
                  visibleRegionDownload: false,
                },
          },
          adapter: predictionUnindexed
            ? { type: 'UnindexedFastaAdapter', fastaLocation: { uri: referenceUrl } }
            : {
                type: 'BgzipFastaAdapter',
                fastaLocation: { uri: referenceUrl },
                faiLocation: { uri: resolveAsset(referenceBase, referenceAssets.fastaFai) },
                gziLocation: { uri: resolveAsset(referenceBase, referenceAssets.fastaGzi) },
              },
        },
      },
      tracks,
      plugins: [
        RapptorMirroredScorePlugin,
        RapptorStrandFeaturePlugin,
        RapptorExperimentalTssPlugin,
        RapptorTrackDownloadPlugin,
      ],
      defaultSession: {
        name: `${assemblyName} evidence view`,
        view: {
          id: `${assemblyName}-unified-linear-view`,
          type: 'LinearGenomeView',
          tracks: sessionTracks,
        },
      },
      onChange: () => {
        const view = stateTree?.session.view;
        if (!view || !view.initialized || view.width <= 0) return;
        const extracted = extractJBrowseShareState(view, registry);
        setShareAvailable(extracted.kind === 'valid');
        setShareUnavailableReason(extracted.kind === 'invalid' ? extracted.warnings.join(' ') : '');
        if (onRegionChange) {
          const region = visibleTrackRegion(view);
          if (region) onRegionChange(region);
        }
      },
    });
    return {
      viewState: stateTree,
      trackRegistry: registry,
      initialWarnings,
      trackLabels: new Map(tracks.map((track) => [String(track.trackId), String(track.name)])),
    };
  }, [assemblyName, experimental, onRegionChange, parsedShare, prediction, studies]);

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
          : defaultLocus;
        try {
          await view.navToLocString(initialLocation, assemblyName);
          if (sharedState) {
            const appliedZoom = view.zoomTo(sharedState.bpPerPx, view.width / 2);
            const actualZoom = Number.isFinite(appliedZoom) ? appliedZoom : view.bpPerPx;
            const tolerance = Math.max(1e-9, sharedState.bpPerPx * 1e-6);
            if (Math.abs(actualZoom - sharedState.bpPerPx) > tolerance) {
              warnings.push('This device cannot reproduce the exact shared zoom level; the nearest supported zoom is shown.');
            }
            const center = view.pxToBp(view.width / 2);
            const centerMatches = !center.oob
              && center.refName === sharedState.refName
              && Number.isSafeInteger(center.coord)
              && Math.abs(center.coord - sharedState.center) <= 1
              && (center.reversed === true) === sharedState.reversed;
            if (!centerMatches) {
              warnings.push('The shared center coordinate or orientation is unavailable. The genome default view is shown instead.');
              await view.navToLocString(defaultLocus, assemblyName);
            }
          }
        } catch {
          if (sharedState) warnings.push('The shared reference location is unavailable. The genome default view is shown instead.');
          try {
            await view.navToLocString(defaultLocus, assemblyName);
          } catch {
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
    return () => { active = false; };
  }, [assemblyName, defaultLocus, initialWarnings, parsedShare, trackRegistry, viewState]);

  useEffect(() => {
    const sequenceTrackId = `${assemblyName}-reference-sequence`;
    const updateFailures = () => {
      const failures = inspectUnifiedJBrowseFailures(viewState, assemblyName, sequenceTrackId, trackLabels);
      setReferenceFailureMessage(failures.referenceFailed
        ? 'Genome browser unavailable: the reference sequence could not be loaded.' : '');
      setPartialViewMessage(!failures.referenceFailed && failures.optionalTrackLabels.length
        ? `Partial view: ${failures.optionalTrackLabels.join(', ')} could not be loaded. The reference sequence and other available evidence remain usable.`
        : '');
    };
    updateFailures();
    // JBrowse stores adapter/render errors in volatile state, which is not
    // emitted through createViewState's MST onPatch callback.
    const timer = window.setInterval(updateFailures, 250);
    return () => window.clearInterval(timer);
  }, [assemblyName, trackLabels, viewState]);

  const handleShare = async () => {
    const extracted = extractJBrowseShareState(viewState.session.view, trackRegistry);
    if (extracted.kind === 'invalid') {
      const message = extracted.warnings.join(' ') || 'This view cannot be shared.';
      setShareAvailable(false);
      setShareUnavailableReason(message);
      setShareFeedback({ message });
      return;
    }
    const url = buildJBrowseShareUrl(window.location, extracted.state, allowedStudyIds);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(url);
      setShareFeedback({ message: 'Link copied' });
    } catch {
      setShareFeedback({ message: 'Clipboard access is unavailable. Copy the link manually.', manualUrl: url });
    }
  };

  return (
    <div className="portal-browser-shell" data-testid="jbrowse-viewer" data-viewer-kind="unified">
      <div className="browser-share-actions">
        <div className="browser-share-feedback" aria-live="polite">
          {!shareAvailable && shareUnavailableReason ? <span id="unified-browser-share-unavailable">{shareUnavailableReason}</span> : null}
          {shareFeedback?.message ? <span>{shareFeedback.message}</span> : null}
        </div>
        <button
          type="button"
          className="browser-share-button"
          onClick={() => void handleShare()}
          disabled={!shareAvailable}
          aria-label="Share current view"
          aria-describedby={!shareAvailable ? 'unified-browser-share-unavailable' : undefined}
          title={shareAvailable ? 'Copy this position, zoom, direction and evidence track layout' : shareUnavailableReason}
        >
          <ShareRoundedIcon aria-hidden="true" />
          <span>Share view</span>
        </button>
      </div>
      {restoreMessage ? <p className="browser-share-notice" role="status">{restoreMessage}</p> : null}
      {partialViewMessage ? <p className="browser-share-notice" role="status">{partialViewMessage}</p> : null}
      {shareFeedback?.manualUrl ? (
        <label className="browser-share-manual">
          <span>Share link</span>
          <input
            aria-label="Share link"
            readOnly
            value={shareFeedback.manualUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}
      {referenceFailureMessage
        ? <div className="browser-unavailable" role="alert"><strong>{referenceFailureMessage}</strong><p>Check the reference FASTA and its FAI/GZI indexes before retrying.</p></div>
        : <div className="portal-browser"><RapptorJBrowseLinearView viewState={viewState} /></div>}
    </div>
  );
}
