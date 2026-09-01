'use client';

import { useEffect, useMemo, useState } from 'react';
import UnifiedBrowserPanel from '@/features/genome-browser/components/unified-browser-panel';
import type { JBrowseAssemblyConfig } from '@/features/genome-browser/types';
import styles from './prediction.module.css';

export default function PredictionBrowser({ jobId, refName }: { jobId: string; refName: string }) {
  const [annotation, setAnnotation] = useState<{ name: string; url: string } | null>(null);
  const base = `/api/predictions/jobs/${jobId}/artifacts`;

  useEffect(() => () => {
    if (annotation) URL.revokeObjectURL(annotation.url);
  }, [annotation]);

  const assembly = useMemo<JBrowseAssemblyConfig>(() => {
    const assemblyName = `prediction-${jobId}`;
    return {
      assemblyName,
      defaultLocus: `${refName}:1-10000`,
      assetBase: '',
      adapterMode: 'indexed',
      annotationTrackKind: 'annotation',
      assets: {
        fasta: `${base}/input.fasta`,
        fastaFai: `${base}/input.fasta.fai`,
        fastaGzi: '',
        predictedPromoters: '',
        predictedPromotersIndex: '',
        promoterScoresPlus: `${base}/scores.plus.bw`,
        promoterScoresMinus: `${base}/scores.minus.bw`,
        ncbiAnnotations: annotation?.url || null,
        ncbiAnnotationsIndex: null,
      },
      trackLabels: {
        scores: 'RAPPTOR raw scores (+ / - strands)',
        annotation: annotation ? `Uploaded annotation · ${annotation.name}` : undefined,
      },
    };
  }, [annotation, base, jobId, refName]);

  return <>
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
    <UnifiedBrowserPanel prediction={assembly} />
  </>;
}
