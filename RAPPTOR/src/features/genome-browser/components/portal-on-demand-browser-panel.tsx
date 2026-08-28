'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import GenomeFileStatus, {
  type GenomeFileKind,
  type GenomeFileProgress,
  type GenomeFileState,
} from '@/features/genome-browser/components/genome-file-status';
import UnifiedBrowserPanel from '@/features/genome-browser/components/unified-browser-panel';
import {
  firstFastaRefName,
  loadCachedGenomeAsset,
  readCachedGenomeAsset,
  MAX_FULL_SCORE_DOWNLOAD_BYTES,
  maybeDecompressGzip,
  shouldDownloadWholeAsset,
  type GenomeAssetProgress,
} from '@/features/genome-browser/on-demand-genome-assets';
import type { PlannedGenomeAssets } from '@/features/storage/hf-batch-assets';
import type { ExperimentalTssGenome } from '@/types/experimental-tss';
import type { JBrowseReleaseAssembly } from '@/types/release';

type Props = {
  accession: string;
  releaseId: string;
  plannedAssets: PlannedGenomeAssets;
  experimental?: ExperimentalTssGenome | null;
};

type FileStates = { reference: GenomeFileState; promoters: GenomeFileState; scores: GenomeFileState; annotation: GenomeFileState };
type FileProgress = Partial<Record<GenomeFileKind, GenomeFileProgress>>;

function initialFileStates(hasAnnotation: boolean, hasScores: boolean): FileStates {
  return {
    reference: 'preparing',
    promoters: 'preparing',
    scores: hasScores ? 'preparing' : 'unavailable',
    annotation: hasAnnotation ? 'preparing' : 'unavailable',
  };
}

function objectUrl(blob: Blob, type: string) {
  return URL.createObjectURL(new Blob([blob], { type }));
}

function assetCacheKey(prefix: string, kind: string, url: string, version: string | null) {
  return `${prefix}/${kind}/${version || url}`;
}

function progressLabel(progress: GenomeAssetProgress): GenomeFileProgress {
  if (progress.phase === 'caching') return { label: 'Saving cache', value: 100 };
  if (progress.phase === 'cached') return { label: 'Reading cache', value: 100 };
  if (progress.total && progress.total > 0) {
    const value = Math.min(100, Math.round(progress.loaded * 100 / progress.total));
    return { label: `Downloading ${value}%`, value };
  }
  return { label: 'Downloading' };
}

export default function PortalOnDemandBrowserPanel({ accession, releaseId, plannedAssets, experimental }: Props) {
  const [assembly, setAssembly] = useState<JBrowseReleaseAssembly | null>(null);
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [error, setError] = useState('');
  const hasScores = Boolean(plannedAssets.promoterScoresPlus && plannedAssets.promoterScoresMinus);
  const [fileStates, setFileStates] = useState<FileStates>(() => initialFileStates(Boolean(plannedAssets.ncbiAnnotations), hasScores));
  const [fileProgress, setFileProgress] = useState<FileProgress>({});
  const objectUrls = useRef<string[]>([]);
  const abortController = useRef<AbortController | null>(null);

  useEffect(() => () => {
    abortController.current?.abort();
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const prepare = useCallback(async () => {
    abortController.current?.abort();
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current = [];
    const controller = new AbortController();
    abortController.current = controller;
    setAssembly(null);
    setStatus('loading');
    setError('');
    setFileStates(initialFileStates(Boolean(plannedAssets.ncbiAnnotations), hasScores));
    setFileProgress({
      reference: { label: 'Checking cache' },
      promoters: { label: 'Checking cache' },
      ...(hasScores ? { scores: { label: 'Range streaming' } } : {}),
      ...(plannedAssets.ncbiAnnotations ? { annotation: { label: 'Checking cache' } } : {}),
    });
    try {
      const cachePrefix = `${releaseId}/${accession}`;
      const load = async (kind: keyof FileStates, url: string, cacheKey: string) => {
        try {
          const blob = await loadCachedGenomeAsset(url, cacheKey, controller.signal, {
            onProgress: (progress) => {
              if (!controller.signal.aborted) {
                setFileProgress((current) => ({ ...current, [kind]: progressLabel(progress) }));
              }
            },
          });
          if (!controller.signal.aborted) {
            setFileProgress((current) => ({ ...current, [kind]: { label: 'Decompressing' } }));
          }
          const prepared = await maybeDecompressGzip(blob);
          if (!controller.signal.aborted) {
            setFileStates((current) => ({ ...current, [kind]: 'available' }));
            setFileProgress((current) => ({ ...current, [kind]: { label: 'Cached', value: 100 } }));
          }
          return prepared;
        } catch (cause) {
          if (!controller.signal.aborted) setFileStates((current) => ({ ...current, [kind]: 'failed' }));
          throw cause;
        }
      };
      const loadScores = async () => {
        if (!plannedAssets.promoterScoresPlus || !plannedAssets.promoterScoresMinus) return [null, null] as const;
        const scoreUrls = [plannedAssets.promoterScoresPlus, plannedAssets.promoterScoresMinus] as const;
        const scoreKeys = [
          assetCacheKey(cachePrefix, 'scores-plus', plannedAssets.promoterScoresPlus, plannedAssets.cacheVersions.promoterScoresPlus),
          assetCacheKey(cachePrefix, 'scores-minus', plannedAssets.promoterScoresMinus, plannedAssets.cacheVersions.promoterScoresMinus),
        ] as const;

        const syncSmallScore = async (url: string, cacheKey: string) => {
          try {
            if (!await shouldDownloadWholeAsset(url, controller.signal)) return null;
            return await loadCachedGenomeAsset(url, cacheKey, controller.signal, {
              maximumBytes: MAX_FULL_SCORE_DOWNLOAD_BYTES,
              onProgress: (progress) => {
                if (!controller.signal.aborted) {
                  setFileProgress((current) => ({ ...current, scores: progressLabel(progress) }));
                }
              },
            });
          } catch {
            return null;
          }
        };

        const loadScoreSource = async (url: string, cacheKey: string) => {
          const cached = await readCachedGenomeAsset(cacheKey, { maximumBytes: MAX_FULL_SCORE_DOWNLOAD_BYTES });
          if (cached) return cached;
          const downloaded = await syncSmallScore(url, cacheKey);
          if (downloaded) return downloaded;
          return url;
        };

        const sources = await Promise.all(scoreUrls.map((url, index) => loadScoreSource(url, scoreKeys[index])));
        if (!controller.signal.aborted) {
          setFileStates((current) => ({ ...current, scores: 'available' }));
          setFileProgress((current) => ({ ...current, scores: { label: 'Available', value: 100 } }));
        }
        return sources;
      };
      const [reference, promoterGff, annotationGff, scores] = await Promise.all([
        load('reference', plannedAssets.reference, assetCacheKey(cachePrefix, 'reference', plannedAssets.reference, plannedAssets.cacheVersions.reference)),
        load('promoters', plannedAssets.predictedPromoters, assetCacheKey(cachePrefix, 'promoters', plannedAssets.predictedPromoters, plannedAssets.cacheVersions.predictedPromoters)),
        plannedAssets.ncbiAnnotations
          ? load('annotation', plannedAssets.ncbiAnnotations, assetCacheKey(cachePrefix, 'ncbi', plannedAssets.ncbiAnnotations, plannedAssets.cacheVersions.ncbiAnnotations)).catch(() => null)
          : Promise.resolve(null),
        loadScores(),
      ]);
      const header = await reference.slice(0, 256 * 1024).text();
      const refName = firstFastaRefName(header);
      if (!refName) throw new Error('The reference assembly does not contain a FASTA sequence header.');

      const fastaUrl = objectUrl(reference, 'text/plain');
      const promoterUrl = objectUrl(promoterGff, 'text/plain');
      const annotationUrl = annotationGff ? objectUrl(annotationGff, 'text/plain') : null;
      const scorePlusUrl = scores[0] ? typeof scores[0] === 'string' ? scores[0] : objectUrl(scores[0], 'application/x-bigwig') : null;
      const scoreMinusUrl = scores[1] ? typeof scores[1] === 'string' ? scores[1] : objectUrl(scores[1], 'application/x-bigwig') : null;
      objectUrls.current = [
        fastaUrl,
        promoterUrl,
        ...(annotationUrl ? [annotationUrl] : []),
        ...(scorePlusUrl && typeof scores[0] !== 'string' ? [scorePlusUrl] : []),
        ...(scoreMinusUrl && typeof scores[1] !== 'string' ? [scoreMinusUrl] : []),
      ];
      setAssembly({
        assemblyName: accession,
        defaultLocus: `${refName}:1-10000`,
        assetBase: '',
        adapterMode: 'unindexed',
        assets: {
          fasta: fastaUrl,
          fastaFai: '',
          fastaGzi: '',
          predictedPromoters: promoterUrl,
          predictedPromotersIndex: '',
          promoterScoresPlus: scorePlusUrl,
          promoterScoresMinus: scoreMinusUrl,
          ncbiAnnotations: annotationUrl,
          ncbiAnnotationsIndex: null,
          metadata: null,
        },
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Genome files could not be prepared.');
      setStatus('error');
    }
  }, [accession, hasScores, plannedAssets, releaseId]);

  useEffect(() => {
    void prepare();
  }, [prepare]);

  if (assembly) return <>
    <GenomeFileStatus states={fileStates} progress={fileProgress} />
    <UnifiedBrowserPanel prediction={assembly} experimental={experimental} />
  </>;

  return (
    <>
      <GenomeFileStatus states={fileStates} progress={fileProgress} />
      <div className="browser-unavailable browser-on-demand">
        <strong>{status === 'loading' ? 'Preparing genome browser' : 'Genome browser could not be loaded'}</strong>
        {status === 'loading'
          ? <p>Loading this genome from the local browser cache or release storage.</p>
          : <><p className="browser-load-error" role="alert">{error}</p><button type="button" className="browser-load-button" onClick={() => void prepare()}><PlayArrowRoundedIcon aria-hidden="true" />Retry</button></>}
      </div>
    </>
  );
}
