'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import RapptorAboutTrackPlugin from '@/features/genome-browser/plugins/about-track-plugin';
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
import { PORTAL_TERMS } from '@/components/portal-terminology';

export interface BrowserRegion {
  refName: string;
  start: number;
  end: number;
}

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
  const allowShareView = prediction?.allowShareView !== false;
  const shareUnavailableByDefault = allowShareView
    ? 'Share becomes available after one reference sequence loads.'
    : 'Browser-local prototype input cannot be shared.';
  // The prediction assembly supplies the reference FASTA whenever both
  // evidence types are present, so its contig name is the only safe default
  // location. Experimental metadata may use an accession fallback that is
  // not a FASTA reference name.
  const defaultLocus = prediction?.defaultLocus || experimental?.defaultLocus || `${assemblyName}:1-10000`;
  const [shareAvailable, setShareAvailable] = useState(false);
  const [shareUnavailableReason, setShareUnavailableReason] = useState(
    shareUnavailableByDefault,
  );
  const [shareTarget, setShareTarget] = useState<Element | null>(null);
  const [restoreMessage, setRestoreMessage] = useState('');
  const [partialViewMessage, setPartialViewMessage] = useState('');
  const [referenceFailureMessage, setReferenceFailureMessage] = useState('');
  const [shareFeedback, setShareFeedback] = useState<ShareFeedback | null>(null);
  const initializationPromises = useRef(new WeakMap<object, Promise<string[]>>());

  useEffect(() => {
    setShareTarget(document.querySelector('.genome-file-status-share'));
  }, []);
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
    const alwaysIncludedSnapshots: SessionTrackSnapshot[] = [];
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
      const scoreTrackLabel = prediction.trackLabels?.scores || 'RAPPTOR model scores (+ / − strands)';
      staticRegistry.scores = trackId;
      tracks.push({
        trackId,
        name: scoreTrackLabel,
        metadata: {
          rapptorMirroredScore: true,
          rapptorDownloads: [
            predictionDownload('scores-plus', `${scoreTrackLabel} (+ strand)`, plusUrl, false).rapptorDownload,
            predictionDownload('scores-minus', `${scoreTrackLabel} (- strand)`, minusUrl, false).rapptorDownload,
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
    } else if (prediction?.assets.promoterScoresPlus) {
      const trackId = `${assemblyName}-promoter-scores`;
      const plusUrl = resolveAsset(prediction.assetBase, prediction.assets.promoterScoresPlus);
      const scoreTrackLabel = prediction.trackLabels?.scores || 'RAPPTOR model scores (+ strand)';
      staticRegistry.scores = trackId;
      tracks.push({
        trackId,
        name: scoreTrackLabel,
        metadata: predictionDownload('scores-plus', scoreTrackLabel, plusUrl, false),
        assemblyNames: [assemblyName],
        type: 'QuantitativeTrack',
        adapter: { type: 'BigWigAdapter', bigWigLocation: { uri: plusUrl } },
        displays: [{
          displayId: `${trackId}-display`,
          type: 'LinearWiggleDisplay',
          defaultRendering: 'xyplot',
          autoscale: 'local',
          minScore: 0,
          maxScore: 1,
        }],
      });
      definitions.push({
        token: 'scores',
        snapshot: {
          type: 'QuantitativeTrack',
          configuration: trackId,
          displays: [{ type: 'LinearWiggleDisplay', configuration: `${trackId}-display`, heightPreConfig: 180 }],
        },
      });
    }

    if (!prediction?.assets.promoterScoresPlus && prediction?.prototypeTracks?.rawScoresBedGraphPlus) {
      const plusUrl = resolveAsset(prediction.assetBase, prediction.prototypeTracks.rawScoresBedGraphPlus);
      const minusUrl = prediction.prototypeTracks.rawScoresBedGraphMinus
        ? resolveAsset(prediction.assetBase, prediction.prototypeTracks.rawScoresBedGraphMinus)
        : null;
      const scoreTrackLabel = prediction.prototypeTracks.rawScoresLabel || 'Illustrative model scores';
      const plusTrackId = `${assemblyName}-prototype-raw-scores-plus`;
      const plusTrackName = minusUrl ? `${scoreTrackLabel} · + strand` : scoreTrackLabel;
      staticRegistry.scores = plusTrackId;
      tracks.push({
        trackId: plusTrackId,
        name: plusTrackName,
        metadata: {
          ...predictionDownload('scores-plus', plusTrackName, plusUrl),
          rapptorEvidenceType: 'illustrative_prototype',
        },
        assemblyNames: [assemblyName],
        type: 'QuantitativeTrack',
        adapter: { type: 'BedGraphAdapter', bedGraphLocation: { uri: plusUrl } },
        displays: [{
          displayId: `${plusTrackId}-display`,
          type: 'LinearWiggleDisplay',
          defaultRendering: 'xyplot',
          autoscale: 'local',
          minScore: 0,
          maxScore: 1,
        }],
      });
      definitions.push({
        token: 'scores',
        snapshot: {
          type: 'QuantitativeTrack',
          configuration: plusTrackId,
          displays: [{ type: 'LinearWiggleDisplay', configuration: `${plusTrackId}-display`, heightPreConfig: minusUrl ? 120 : 180 }],
        },
      });
      if (minusUrl) {
        const minusTrackId = `${assemblyName}-prototype-raw-scores-minus`;
        const minusTrackName = `${scoreTrackLabel} · − strand`;
        tracks.push({
          trackId: minusTrackId,
          name: minusTrackName,
          metadata: {
            ...predictionDownload('scores-minus', minusTrackName, minusUrl),
            rapptorEvidenceType: 'illustrative_prototype',
          },
          assemblyNames: [assemblyName],
          type: 'QuantitativeTrack',
          adapter: { type: 'BedGraphAdapter', bedGraphLocation: { uri: minusUrl } },
          displays: [{
            displayId: `${minusTrackId}-display`,
            type: 'LinearWiggleDisplay',
            defaultRendering: 'xyplot',
            autoscale: 'local',
            minScore: 0,
            maxScore: 1,
          }],
        });
        alwaysIncludedSnapshots.push({
          type: 'QuantitativeTrack',
          configuration: minusTrackId,
          displays: [{ type: 'LinearWiggleDisplay', configuration: `${minusTrackId}-display`, heightPreConfig: 120 }],
        });
      }
    }

    const experimentalPromoters = experimental?.assets.predictedPromoters || null;
    const promoterBase = experimentalPromoters ? experimental!.assetBase : prediction?.assetBase || '';
    const promoterData = experimentalPromoters || prediction?.assets.predictedPromoters || null;
    const promoterIndex = experimentalPromoters
      ? experimental?.assets.predictedPromotersIndex || null
      : prediction?.assets.predictedPromotersIndex || null;
    if (promoterData) {
      const trackId = `${assemblyName}-predicted-promoters`;
      const dataUrl = resolveAsset(promoterBase, promoterData);
      const promoterTrackLabel = prediction?.trackLabels?.promoters || `RAPPTOR ${PORTAL_TERMS.promoterPredictions.toLowerCase()}`;
      const promoterUnindexed = experimentalPromoters ? !promoterIndex : predictionUnindexed || !promoterIndex;
      staticRegistry.promoters = trackId;
      tracks.push({
        trackId,
        name: promoterTrackLabel,
        metadata: {
          ...predictionDownload('promoters', promoterTrackLabel, dataUrl),
          rapptorEvidenceType: 'prediction',
          rapptorStrandFeatureMode: 'promoter',
          rapptorProcessing: {
            sigma: prediction?.predictionProcessing?.sigma ?? 1,
            distance: prediction?.predictionProcessing?.distance ?? 10,
            cutoff: prediction?.predictionProcessing?.cutoff ?? 0.9,
            positionBase: prediction?.predictionProcessing?.positionBase ?? 0,
          },
        },
        assemblyNames: [assemblyName],
        type: 'FeatureTrack',
        adapter: promoterUnindexed
          ? { type: 'Gff3Adapter', gffLocation: { uri: dataUrl } }
          : {
              type: 'Gff3TabixAdapter',
              gffGzLocation: { uri: dataUrl },
              index: {
                indexType: 'TBI',
                location: { uri: resolveAsset(promoterBase, promoterIndex!) },
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

    if (!promoterData && prediction?.prototypeTracks?.calledPeaksGff3) {
      const trackId = `${assemblyName}-prototype-called-peaks`;
      const dataUrl = resolveAsset(prediction.assetBase, prediction.prototypeTracks.calledPeaksGff3);
      const calledPeaksLabel = prediction.prototypeTracks.calledPeaksLabel || 'Illustrative promoter predictions';
      staticRegistry.promoters = trackId;
      tracks.push({
        trackId,
        name: calledPeaksLabel,
        metadata: {
          ...predictionDownload('promoters', calledPeaksLabel, dataUrl),
          rapptorEvidenceType: 'illustrative_prototype',
          rapptorProcessing: {
            sigma: prediction.predictionProcessing?.sigma ?? 1,
            distance: prediction.predictionProcessing?.distance ?? 10,
            cutoff: prediction.predictionProcessing?.cutoff ?? 0.9,
            positionBase: prediction.predictionProcessing?.positionBase ?? 0,
          },
        },
        assemblyNames: [assemblyName],
        type: 'FeatureTrack',
        adapter: { type: 'Gff3Adapter', gffLocation: { uri: dataUrl } },
        displays: [{
          displayId: `${trackId}-display`,
          type: 'LinearBasicDisplay',
          renderer: {
            type: 'SvgFeatureRenderer',
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
      const pubmedUrl = `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(study.pmid)}/`;
      const doiUrl = study.publication.doi
        ? `https://doi.org/${study.publication.doi.split('/').map(encodeURIComponent).join('/')}`
        : null;
      tracks.push({
        trackId,
        name: `Experimental TSS · ${study.year} · PMID ${study.pmid}`,
        description: [study.publication.title, study.publication.journal, `${study.recordCount.toLocaleString('en-US')} observations`]
          .filter(Boolean).join(' · '),
        metadata: {
          rapptorEvidenceType: 'experimental_tss',
          rapptorDownload: {
            kind: 'raw-bed',
            accession: study.accession,
            label: `Experimental TSS · ${study.year} · PMID ${study.pmid}`,
            regionExportBase: '',
            wholeAssetUrl: resolveAsset(experimental!.assetBase, study.assets.rawBed),
            visibleRegionDownload: false,
          } satisfies TrackDownloadMetadata,
          rapptorStudy: {
            studyId: study.studyId,
            pmid: study.pmid,
            year: study.year,
            recordCount: study.recordCount,
            title: study.publication.title,
            journal: study.publication.journal,
            authors: study.publication.authors,
            pubmedUrl,
            doiUrl,
          },
          rapptorExperimentalDownloads: [
            {
              kind: 'raw-bed',
              label: 'Original BED observations',
              url: resolveAsset(experimental!.assetBase, study.assets.rawBed),
              sourcePath: study.assets.rawBed,
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

    if (prediction?.assets.ncbiAnnotations) {
      const annotationLabel = prediction.trackLabels?.annotation || 'NCBI genome annotation';
      const trackId = `${assemblyName}-ncbi-annotations`;
      const dataUrl = resolveAsset(prediction.assetBase, prediction.assets.ncbiAnnotations);
      const annotationUnindexed = predictionUnindexed || !prediction.assets.ncbiAnnotationsIndex;
      staticRegistry.annotation = trackId;
      tracks.push({
        trackId,
        name: annotationLabel,
        metadata: {
          ...predictionDownload(prediction.annotationTrackKind || 'ncbi', annotationLabel, dataUrl),
          rapptorStrandFeatureMode: 'annotation',
          ...(prediction.annotationAbout ? { rapptorAnnotation: prediction.annotationAbout } : {}),
        },
        assemblyNames: [assemblyName],
        type: 'FeatureTrack',
        adapter: annotationUnindexed
          ? { type: 'Gff3Adapter', gffLocation: { uri: dataUrl } }
          : {
              type: 'Gff3TabixAdapter',
              gffGzLocation: { uri: dataUrl },
              index: { indexType: 'TBI', location: { uri: resolveAsset(prediction.assetBase, prediction.assets.ncbiAnnotationsIndex!) } },
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
      initialWarnings.unshift('Invalid share link. Showing the default genome view.');
    }
    const requestedTracks = parsedShare.kind === 'valid' ? parsedShare.state.tracks : null;
    const selectedSessionTracks = requestedTracks === null
      ? definitions.flatMap((definition) => definition.token === 'scores'
        ? [definition.snapshot, ...alwaysIncludedSnapshots]
        : [definition.snapshot])
      : requestedTracks.flatMap(({ token, height }) => {
          const definition = definitionsByToken.get(token);
          if (!definition) {
            initialWarnings.push(`${token.replace('study:', 'Study ')} track unavailable for this genome.`);
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
    const sessionTracks = requestedTracks === null
      ? selectedSessionTracks
      : [...selectedSessionTracks, ...alwaysIncludedSnapshots];

    const referenceBase = prediction ? prediction.assetBase : experimental!.assetBase;
    const referenceAssets = prediction?.assets || experimental!.assets;
    const referenceAccession = prediction?.assemblyName || experimental!.accession;
    const referenceUrl = resolveAsset(referenceBase, referenceAssets.fasta);
    const referenceUnindexed = predictionUnindexed || !referenceAssets.fastaFai;
    const stateTree = createViewState({
      assembly: {
        name: assemblyName,
        sequence: {
          type: 'ReferenceSequenceTrack',
          trackId: sequenceTrackId,
          name: prediction?.trackLabels?.reference || 'Reference sequence',
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
          adapter: referenceUnindexed
            ? { type: 'UnindexedFastaAdapter', fastaLocation: { uri: referenceUrl } }
            : referenceAssets.fastaGzi ? {
                type: 'BgzipFastaAdapter',
                fastaLocation: { uri: referenceUrl },
                faiLocation: { uri: resolveAsset(referenceBase, referenceAssets.fastaFai!) },
                gziLocation: { uri: resolveAsset(referenceBase, referenceAssets.fastaGzi!) },
              } : {
                type: 'IndexedFastaAdapter',
                fastaLocation: { uri: referenceUrl },
                faiLocation: { uri: resolveAsset(referenceBase, referenceAssets.fastaFai!) },
              },
        },
      },
      tracks,
      plugins: [
        RapptorMirroredScorePlugin,
        RapptorStrandFeaturePlugin,
        ...(experimental ? [RapptorExperimentalTssPlugin] : []),
        RapptorTrackDownloadPlugin,
        RapptorAboutTrackPlugin,
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
        if (onRegionChange) {
          const region = visibleTrackRegion(view);
          if (region) onRegionChange(region);
        }
        if (!allowShareView) {
          setShareAvailable(false);
          setShareUnavailableReason('Browser-local prototype input cannot be shared.');
          return;
        }
        const extracted = extractJBrowseShareState(view, registry);
        setShareAvailable(extracted.kind === 'valid');
        setShareUnavailableReason(extracted.kind === 'invalid' ? extracted.warnings.join(' ') : '');
      },
    });
    return {
      viewState: stateTree,
      trackRegistry: registry,
      initialWarnings,
      trackLabels: new Map(tracks.map((track) => [String(track.trackId), String(track.name)])),
    };
  }, [allowShareView, assemblyName, experimental, onRegionChange, parsedShare, prediction, studies]);

  useEffect(() => {
    setShareFeedback(null);
    setShareAvailable(false);
    setShareUnavailableReason(shareUnavailableByDefault);
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
              warnings.push('Exact shared zoom unavailable; showing the nearest level.');
            }
            const center = view.pxToBp(view.width / 2);
            const centerMatches = !center.oob
              && center.refName === sharedState.refName
              && Number.isSafeInteger(center.coord)
              && Math.abs(center.coord - sharedState.center) <= 1
              && (center.reversed === true) === sharedState.reversed;
            if (!centerMatches) {
              warnings.push('Shared center or orientation unavailable; showing the default view.');
              await view.navToLocString(defaultLocus, assemblyName);
            }
          }
        } catch {
          if (sharedState) warnings.push('Shared location unavailable; showing the default view.');
          try {
            await view.navToLocString(defaultLocus, assemblyName);
          } catch {
            warnings.push('Default genome location could not be opened.');
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
      if (!allowShareView) return;
      const extracted = extractJBrowseShareState(viewState.session.view, trackRegistry);
      setShareAvailable(extracted.kind === 'valid');
      setShareUnavailableReason(extracted.kind === 'invalid' ? extracted.warnings.join(' ') : '');
    });
    return () => { active = false; };
  }, [allowShareView, assemblyName, defaultLocus, initialWarnings, parsedShare, shareUnavailableByDefault, trackRegistry, viewState]);

  useEffect(() => {
    const sequenceTrackId = `${assemblyName}-reference-sequence`;
    const updateFailures = () => {
      const failures = inspectUnifiedJBrowseFailures(viewState, assemblyName, sequenceTrackId, trackLabels);
      setReferenceFailureMessage(failures.referenceFailed
        ? 'Browser unavailable: reference sequence failed to load.' : '');
      setPartialViewMessage(!failures.referenceFailed && failures.optionalTrackLabels.length
        ? `Partial view: ${failures.optionalTrackLabels.join(', ')} failed to load. Other tracks remain available.`
        : '');
    };
    updateFailures();
    // JBrowse stores adapter/render errors in volatile state, which is not
    // emitted through createViewState's MST onPatch callback.
    const timer = window.setInterval(updateFailures, 250);
    return () => window.clearInterval(timer);
  }, [assemblyName, trackLabels, viewState]);

  const handleShare = async () => {
    if (!allowShareView) return;
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

  const shareActions = allowShareView ? (
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
        title={shareAvailable ? 'Copy position, zoom, direction, and track layout' : shareUnavailableReason}
      >
        <ShareRoundedIcon aria-hidden="true" />
        <span>Share view</span>
      </button>
    </div>
  ) : null;

  return (
    <div className="portal-browser-shell" data-testid="jbrowse-viewer" data-viewer-kind="unified">
      {shareTarget && shareActions ? createPortal(shareActions, shareTarget) : shareActions}
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
        ? <div className="browser-unavailable" role="alert"><strong>{referenceFailureMessage}</strong><p>Check the FASTA and FAI/GZI indexes, then retry.</p></div>
        : <div className="portal-browser"><RapptorJBrowseLinearView viewState={viewState} /></div>}
    </div>
  );
}
