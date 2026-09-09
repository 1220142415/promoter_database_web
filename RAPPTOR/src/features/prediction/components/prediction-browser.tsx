'use client';

import { useEffect, useMemo, useState } from 'react';
import UnifiedBrowserPanel from '@/features/genome-browser/components/unified-browser-panel';
import type { JBrowseAssemblyConfig } from '@/features/genome-browser/types';
import type { JobSummary } from '../live-result';
import styles from './prediction.module.css';

export default function PredictionBrowser({ jobId, refName, accessToken, artifacts, summary }: { jobId: string; refName: string; accessToken: string; artifacts?: readonly { filename: string }[]; summary?: JobSummary }) {
  const [annotation, setAnnotation] = useState<{ name: string; url: string } | null>(null);
  const base = `/api/predictions/jobs/${jobId}/artifacts`;
  const missing = artifacts ? ['input.fasta', 'input.fasta.fai', 'scores.plus.bw'].filter((name) => !artifacts.some((item) => item.filename === name)) : [];
  const hasMinus = !artifacts || artifacts.some((item) => item.filename === 'scores.minus.bw');
  const hasPeaks = artifacts?.some((item) => item.filename === 'peaks.gff3');
  const precomputedScoreSigma = summary?.bigwig_smoothing?.method === 'gaussian'
    && summary.bigwig_smoothing.mode === 'reflect' ? summary.bigwig_smoothing.sigma : undefined;
  const smoothLegacyScores = precomputedScoreSigma === undefined && summary?.stride === 1;
  const smoothedScoreTrack = precomputedScoreSigma !== undefined || smoothLegacyScores;
  const peakStatus = !artifacts || (summary?.stride !== undefined && summary.stride > 1)
    ? null
    : hasPeaks
      ? summary?.peak_count === 0 ? 'No peaks passed the calling cutoff for this task.' : null
      : 'Peak results were not generated for this task.';

  useEffect(() => () => {
    if (annotation) URL.revokeObjectURL(annotation.url);
  }, [annotation]);

  const assembly = useMemo<JBrowseAssemblyConfig>(() => {
    const assemblyName = `prediction-${jobId}`;
    return {
      assemblyName,
      assemblyAbout: { label: 'Contig', name: refName },
      defaultLocus: `${refName}:1-10000`,
      assetBase: '',
      adapterMode: 'indexed',
      annotationTrackKind: 'annotation',
      smoothScoreTrack: smoothLegacyScores,
      precomputedScoreSigma,
      predictionProcessing: hasPeaks && summary?.peak_calling && summary.smoothing ? {
        sigma: summary.smoothing.sigma, distance: summary.peak_calling.distance,
        cutoff: summary.peak_calling.cutoff, positionBase: 1,
      } : undefined,
      assets: {
        fasta: `${base}/input.fasta`,
        fastaFai: `${base}/input.fasta.fai`,
        fastaGzi: '',
        predictedPromoters: hasPeaks ? `${base}/peaks.gff3` : '',
        predictedPromotersIndex: '',
        promoterScoresPlus: `${base}/scores.plus.bw`,
        promoterScoresMinus: hasMinus ? `${base}/scores.minus.bw` : null,
        ncbiAnnotations: annotation?.url || null,
        ncbiAnnotationsIndex: null,
      },
      trackLabels: {
        promoters: 'RAPPtor predicted peaks',
        scores: `${smoothedScoreTrack ? 'RAPPtor smoothed model scores' : 'RAPPTOR model scores'} (${hasMinus ? '+ / − strands' : '+ strand'})`,
        annotation: annotation ? `Uploaded annotation · ${annotation.name}` : undefined,
      },
    };
  }, [annotation, base, jobId, refName, hasMinus, hasPeaks, summary, smoothLegacyScores, precomputedScoreSigma, smoothedScoreTrack]);

  if (missing.length) return <p role="alert">Required browser artifacts are missing: {missing.join(', ')}.</p>;
  return <>
    {peakStatus && <p className={styles.peakStatus} role="status">{peakStatus}</p>}
    <div className={styles.browserTools}>
      <div><strong>Genome context</strong><span>Reference sequence is shown automatically. Optional GFF3 stays in this browser; sequence IDs must match the FASTA headers.</span></div>
      <div className={styles.annotationActions}>
        {annotation && <span title={annotation.name}>{annotation.name}</span>}
        <label><input className="sr-only" type="file" accept=".gff,.gff3,text/plain" onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) setAnnotation({ name: file.name, url: URL.createObjectURL(file) });
          event.currentTarget.value = '';
        }} />{annotation ? 'Replace GFF3' : 'Add GFF3 annotation'}</label>
        {annotation && <button type="button" onClick={() => setAnnotation(null)}>Remove</button>}
      </div>
    </div>
    <UnifiedBrowserPanel
      prediction={assembly}
      shareFragment={new URLSearchParams({ access: accessToken, ref: refName, mode: 'genome_scan' }).toString()}
    />
  </>;
}
