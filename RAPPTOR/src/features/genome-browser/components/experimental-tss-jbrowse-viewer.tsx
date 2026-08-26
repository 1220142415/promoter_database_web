'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createViewState } from '@jbrowse/react-linear-genome-view';
import ShareRoundedIcon from '@mui/icons-material/ShareRounded';
import RapptorJBrowseLinearView from '@/features/genome-browser/components/rapptor-jbrowse-linear-view';
import RapptorExperimentalTssPlugin, { EXPERIMENTAL_TSS_RENDERER } from '@/features/genome-browser/plugins/experimental-tss-plugin';
import RapptorStrandFeaturePlugin, { DIRECTIONAL_ANNOTATION_RENDERER } from '@/features/genome-browser/plugins/strand-feature-plugin';
import RapptorTrackDownloadPlugin from '@/features/genome-browser/plugins/track-download-plugin';
import {
  buildExperimentalJBrowseShareUrl,
  experimentalStudyTrackToken,
  extractExperimentalJBrowseShareState,
  parseExperimentalJBrowseShareParams,
  type ExperimentalShareTrackRegistry,
  type ExperimentalShareTrackToken,
} from '@/features/genome-browser/experimental-jbrowse-share';
import { visibleTrackRegion } from '@/features/genome-browser/track-download';
import type { ExperimentalTssGenome, ExperimentalTssStudy } from '@/types/experimental-tss';
import type { BrowserRegion } from '@/features/genome-browser/components/portal-jbrowse-viewer';

export interface ExperimentalTssDownload {
  readonly kind: 'raw-bed' | 'normalized-gff3';
  readonly label: string;
  readonly url: string;
  readonly sourcePath: string;
}

export type ExperimentalTssStudyTrack = ExperimentalTssStudy;
export type ExperimentalTssBrowserAssembly = ExperimentalTssGenome;

type SessionTrackSnapshot = {
  type: string;
  configuration: string;
  displays: Array<{ type: string; configuration: string; heightPreConfig: number }>;
};

type SessionTrackDefinition = {
  token: ExperimentalShareTrackToken;
  snapshot: SessionTrackSnapshot;
};

type ShareFeedback = { message: string; manualUrl?: string };

function resolveAsset(base: string, path: string) {
  if (/^[a-z][a-z\d+.-]*:/iu.test(path) || path.startsWith('/')) return path;
  return `${base.replace(/\/+$/u, '')}/${path.replace(/^\/+/, '')}`;
}

function studyTrackId(assemblyName: string, studyId: string) {
  return `${assemblyName}-experimental-tss-${studyId}`;
}

export function experimentalStudyDownloads(assetBase: string, study: ExperimentalTssStudy): ExperimentalTssDownload[] {
  return [
    {
      kind: 'raw-bed',
      label: 'Original BED observations',
      url: resolveAsset(assetBase, study.assets.rawBed),
      sourcePath: study.assets.rawBed,
    },
    {
      kind: 'normalized-gff3',
      label: 'Normalized experimental TSS GFF3',
      url: resolveAsset(assetBase, study.assets.data),
      sourcePath: study.assets.data,
    },
  ];
}

export default function ExperimentalTssJBrowseViewer({
  genome,
  onRegionChange,
}: {
  genome: ExperimentalTssGenome;
  onRegionChange?: (region: BrowserRegion) => void;
}) {
  const assemblyName = genome.assemblyName || genome.accession;
  const referenceUnindexed = !genome.assets.fastaFai || !genome.assets.fastaGzi;
  const allowedStudyIds = useMemo(() => new Set(genome.studies.map((study) => study.studyId)), [genome.studies]);
  const [shareAvailable, setShareAvailable] = useState(false);
  const [shareUnavailableReason, setShareUnavailableReason] = useState(
    'Sharing is available for a single reference sequence after the browser loads.',
  );
  const [restoreMessage, setRestoreMessage] = useState('');
  const [shareFeedback, setShareFeedback] = useState<ShareFeedback | null>(null);
  const initializationPromises = useRef(new WeakMap<object, Promise<string[]>>());
  const parsedShare = useMemo(
    () => parseExperimentalJBrowseShareParams(
      new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search),
      allowedStudyIds,
    ),
    [allowedStudyIds],
  );

  const { viewState, trackRegistry, initialWarnings } = useMemo(() => {
    const sequenceTrackId = `${assemblyName}-reference-sequence`;
    const tracks: Array<Record<string, unknown>> = [];
    const sessionDefinitions: SessionTrackDefinition[] = [{
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
    const studyRegistry: Record<string, string> = {};

    if (genome.annotationStatus === 'available'
      && genome.assets.ncbiAnnotations
      && genome.assets.ncbiAnnotationsIndex) {
      const trackId = `${assemblyName}-ncbi-annotations`;
      const dataUrl = resolveAsset(genome.assetBase, genome.assets.ncbiAnnotations);
      tracks.push({
        trackId,
        name: 'NCBI genome annotation',
        metadata: {
          rapptorStrandFeatureMode: 'annotation',
          rapptorDownload: {
            kind: 'ncbi',
            accession: genome.accession,
            label: 'NCBI genome annotation',
            regionExportBase: '',
            wholeAssetUrl: dataUrl,
            downloadMode: 'remote',
            visibleRegionDownload: false,
          },
        },
        assemblyNames: [assemblyName],
        type: 'FeatureTrack',
        adapter: {
          type: 'Gff3TabixAdapter',
          gffGzLocation: { uri: dataUrl },
          index: {
            indexType: 'TBI',
            location: { uri: resolveAsset(genome.assetBase, genome.assets.ncbiAnnotationsIndex) },
          },
        },
        displays: [{
          displayId: `${trackId}-display`,
          type: 'LinearBasicDisplay',
          renderer: { type: DIRECTIONAL_ANNOTATION_RENDERER, height: 10 },
        }],
      });
      sessionDefinitions.push({
        token: 'annotation',
        snapshot: {
          type: 'FeatureTrack',
          configuration: trackId,
          displays: [{ type: 'LinearBasicDisplay', configuration: `${trackId}-display`, heightPreConfig: 170 }],
        },
      });
    }

    for (const study of genome.studies) {
      const token = experimentalStudyTrackToken(study.studyId);
      const trackId = studyTrackId(assemblyName, study.studyId);
      const dataUrl = resolveAsset(genome.assetBase, study.assets.data);
      const downloads = experimentalStudyDownloads(genome.assetBase, study);
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
          rapptorExperimentalDownloads: downloads,
        },
        assemblyNames: [assemblyName],
        type: 'FeatureTrack',
        adapter: study.assets.index
          ? {
              type: 'Gff3TabixAdapter',
              gffGzLocation: { uri: dataUrl },
              index: {
                indexType: 'TBI',
                location: { uri: resolveAsset(genome.assetBase, study.assets.index) },
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
      sessionDefinitions.push({
        token,
        snapshot: {
          type: 'FeatureTrack',
          configuration: trackId,
          displays: [{ type: 'LinearBasicDisplay', configuration: `${trackId}-display`, heightPreConfig: 170 }],
        },
      });
    }

    const annotationDefinition = sessionDefinitions.find((definition) => definition.token === 'annotation');
    const registry: ExperimentalShareTrackRegistry = {
      sequence: sequenceTrackId,
      annotation: annotationDefinition?.snapshot.configuration,
      studies: studyRegistry,
    };
    const definitionsByToken = new Map(sessionDefinitions.map((definition) => [definition.token, definition]));
    const initialWarnings = parsedShare.kind === 'absent' ? [] : [...parsedShare.warnings];
    if (parsedShare.kind === 'invalid') {
      initialWarnings.unshift('This experimental TSS share link is invalid. The genome default view is shown instead.');
    }
    const requestedTracks = parsedShare.kind === 'valid' ? parsedShare.state.tracks : null;
    const sessionTracks = requestedTracks === null
      ? sessionDefinitions.map((definition) => definition.snapshot)
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

    const stateTree = createViewState({
      assembly: {
        name: assemblyName,
        sequence: {
          type: 'ReferenceSequenceTrack',
          trackId: sequenceTrackId,
          name: 'Reference sequence',
          metadata: {
            rapptorDownload: {
              kind: 'reference',
              accession: genome.accession,
              label: 'Reference sequence',
              regionExportBase: '',
              wholeAssetUrl: resolveAsset(genome.assetBase, genome.assets.fasta),
              downloadMode: 'remote',
              visibleRegionDownload: false,
            },
          },
          adapter: referenceUnindexed
            ? { type: 'UnindexedFastaAdapter', fastaLocation: { uri: resolveAsset(genome.assetBase, genome.assets.fasta) } }
            : {
                type: 'BgzipFastaAdapter',
                fastaLocation: { uri: resolveAsset(genome.assetBase, genome.assets.fasta) },
                faiLocation: { uri: resolveAsset(genome.assetBase, genome.assets.fastaFai!) },
                gziLocation: { uri: resolveAsset(genome.assetBase, genome.assets.fastaGzi!) },
              },
        },
      },
      tracks,
      plugins: [RapptorStrandFeaturePlugin, RapptorExperimentalTssPlugin, RapptorTrackDownloadPlugin],
      defaultSession: {
        name: `${genome.accession} experimental TSS view`,
        view: {
          id: `${genome.accession}-experimental-tss-linear-view`,
          type: 'LinearGenomeView',
          tracks: sessionTracks,
        },
      },
      onChange: () => {
        const view = stateTree?.session.view;
        if (!view || !view.initialized || view.width <= 0) return;
        const extracted = extractExperimentalJBrowseShareState(view, registry);
        setShareAvailable(extracted.kind === 'valid');
        setShareUnavailableReason(extracted.kind === 'invalid' ? extracted.warnings.join(' ') : '');
        if (onRegionChange) {
          const region = visibleTrackRegion(view);
          if (region) onRegionChange(region);
        }
      },
    });
    return { viewState: stateTree, trackRegistry: registry, initialWarnings };
  }, [assemblyName, genome, onRegionChange, parsedShare, referenceUnindexed]);

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
          : genome.defaultLocus;
        try {
          await view.navToLocString(initialLocation, assemblyName);
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
              warnings.push('The shared center coordinate or orientation is unavailable. The genome default view is shown instead.');
              await view.navToLocString(genome.defaultLocus, assemblyName);
            }
          }
        } catch {
          if (sharedState) {
            warnings.push('The shared reference location is unavailable. The genome default view is shown instead.');
            try {
              await view.navToLocString(genome.defaultLocus, assemblyName);
            } catch {
              warnings.push('The genome default location could not be opened.');
            }
          } else warnings.push('The genome default location could not be opened.');
        }
        return warnings;
      })();
      initializationPromises.current.set(viewState, initialization);
    }
    let active = true;
    void initialization.then((warnings) => {
      if (!active) return;
      setRestoreMessage(warnings.join(' '));
      const extracted = extractExperimentalJBrowseShareState(viewState.session.view, trackRegistry);
      setShareAvailable(extracted.kind === 'valid');
      setShareUnavailableReason(extracted.kind === 'invalid' ? extracted.warnings.join(' ') : '');
    });
    return () => { active = false; };
  }, [assemblyName, genome.defaultLocus, initialWarnings, parsedShare, trackRegistry, viewState]);

  const handleShare = async () => {
    const extracted = extractExperimentalJBrowseShareState(viewState.session.view, trackRegistry);
    if (extracted.kind === 'invalid') {
      const message = extracted.warnings.join(' ') || 'This view cannot be shared.';
      setShareAvailable(false);
      setShareUnavailableReason(message);
      setShareFeedback({ message });
      return;
    }
    const url = buildExperimentalJBrowseShareUrl(window.location, extracted.state, allowedStudyIds);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(url);
      setShareFeedback({ message: 'Link copied' });
    } catch {
      setShareFeedback({ message: 'Clipboard access is unavailable. Copy the link manually.', manualUrl: url });
    }
  };

  return (
    <div className="portal-browser-shell" data-testid="experimental-tss-jbrowse-viewer">
      <div className="browser-share-actions">
        <div className="browser-share-feedback" aria-live="polite">
          {!shareAvailable && shareUnavailableReason ? <span id="experimental-browser-share-unavailable">{shareUnavailableReason}</span> : null}
          {shareFeedback?.message ? <span>{shareFeedback.message}</span> : null}
        </div>
        <button
          type="button"
          className="browser-share-button"
          onClick={() => void handleShare()}
          disabled={!shareAvailable}
          aria-label="Share current experimental TSS view"
          aria-describedby={!shareAvailable ? 'experimental-browser-share-unavailable' : undefined}
          title={shareAvailable ? 'Copy this experimental TSS position, zoom, direction and track layout' : shareUnavailableReason}
        >
          <ShareRoundedIcon aria-hidden="true" />
          <span>Share view</span>
        </button>
      </div>
      {restoreMessage ? <p className="browser-share-notice" role="status">{restoreMessage}</p> : null}
      {shareFeedback?.manualUrl ? (
        <label className="browser-share-manual">
          <span>Share link</span>
          <input
            aria-label="Experimental TSS share link"
            readOnly
            value={shareFeedback.manualUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}
      <div className="portal-browser">
        <RapptorJBrowseLinearView viewState={viewState} />
      </div>
    </div>
  );
}
