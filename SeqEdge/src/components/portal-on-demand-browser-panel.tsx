'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import PortalBrowserPanel from '@/components/portal-browser-panel';
import { firstFastaRefName, loadCachedGenomeAsset, maybeDecompressGzip } from '@/lib/on-demand-genome-assets';
import type { PlannedGenomeAssets } from '@/lib/hf-batch-assets';
import type { JBrowseReleaseAssembly } from '@/types/release';

type Props = {
  accession: string;
  releaseId: string;
  plannedAssets: PlannedGenomeAssets;
};

function objectUrl(blob: Blob, type: string) {
  return URL.createObjectURL(new Blob([blob], { type }));
}

export default function PortalOnDemandBrowserPanel({ accession, releaseId, plannedAssets }: Props) {
  const [assembly, setAssembly] = useState<JBrowseReleaseAssembly | null>(null);
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [error, setError] = useState('');
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
    setStatus('loading');
    setError('');
    try {
      const cachePrefix = `${releaseId}/${accession}`;
      const [compressedReference, promoters, annotation] = await Promise.all([
        loadCachedGenomeAsset(plannedAssets.reference, `${cachePrefix}/reference`, controller.signal),
        loadCachedGenomeAsset(plannedAssets.predictedPromoters, `${cachePrefix}/promoters`, controller.signal),
        plannedAssets.ncbiAnnotations
          ? loadCachedGenomeAsset(plannedAssets.ncbiAnnotations, `${cachePrefix}/ncbi`, controller.signal).catch(() => null)
          : Promise.resolve(null),
      ]);
      const [reference, promoterGff, annotationGff] = await Promise.all([
        maybeDecompressGzip(compressedReference),
        maybeDecompressGzip(promoters),
        annotation ? maybeDecompressGzip(annotation) : Promise.resolve(null),
      ]);
      const header = await reference.slice(0, 256 * 1024).text();
      const refName = firstFastaRefName(header);
      if (!refName) throw new Error('The reference assembly does not contain a FASTA sequence header.');

      const fastaUrl = objectUrl(reference, 'text/plain');
      const promoterUrl = objectUrl(promoterGff, 'text/plain');
      const annotationUrl = annotationGff ? objectUrl(annotationGff, 'text/plain') : null;
      objectUrls.current = [fastaUrl, promoterUrl, ...(annotationUrl ? [annotationUrl] : [])];
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
  }, [accession, plannedAssets.ncbiAnnotations, plannedAssets.predictedPromoters, plannedAssets.reference, releaseId]);

  useEffect(() => {
    void prepare();
  }, [prepare]);

  if (assembly) return <PortalBrowserPanel assembly={assembly} />;

  return (
    <div className="browser-unavailable browser-on-demand">
      <strong>{status === 'loading' ? 'Preparing genome browser' : 'Genome browser could not be loaded'}</strong>
      {status === 'loading'
        ? <p>Loading this genome from the local browser cache or release storage.</p>
        : <><p className="browser-load-error" role="alert">{error}</p><button type="button" className="browser-load-button" onClick={() => void prepare()}><PlayArrowRoundedIcon aria-hidden="true" />Retry</button></>}
    </div>
  );
}
