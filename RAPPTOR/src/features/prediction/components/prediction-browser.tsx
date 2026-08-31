'use client';

import { useEffect, useMemo, useState } from 'react';
import { createViewState } from '@jbrowse/react-linear-genome-view';
import RapptorJBrowseLinearView from '@/features/genome-browser/components/rapptor-jbrowse-linear-view';
import RapptorMirroredScorePlugin from '@/features/genome-browser/plugins/mirrored-score-plugin';
import styles from './prediction.module.css';

export default function PredictionBrowser({ jobId, refName }: { jobId: string; refName: string }) {
  const [annotation, setAnnotation] = useState<{ name: string; url: string } | null>(null);
  const base = `/api/predictions/jobs/${jobId}/artifacts`;

  useEffect(() => () => {
    if (annotation) URL.revokeObjectURL(annotation.url);
  }, [annotation]);

  const viewState = useMemo(() => {
    const assemblyName = `prediction-${jobId}`;
    const sequenceTrackId = `${assemblyName}-reference`;
    const annotationTrackId = `${assemblyName}-user-annotation`;
    const trackId = `${assemblyName}-scores`;
    return createViewState({
      assembly: {
        name: assemblyName,
        sequence: {
          type: 'ReferenceSequenceTrack',
          trackId: sequenceTrackId,
          name: 'Reference sequence',
          adapter: {
            type: 'IndexedFastaAdapter',
            fastaLocation: { uri: `${base}/input.fasta` },
            faiLocation: { uri: `${base}/input.fasta.fai` },
          },
        },
      },
      tracks: [...(annotation ? [{
        trackId: annotationTrackId,
        name: `Uploaded annotation · ${annotation.name}`,
        assemblyNames: [assemblyName],
        type: 'FeatureTrack',
        adapter: { type: 'Gff3Adapter', gffLocation: { uri: annotation.url } },
        displays: [{ displayId: `${annotationTrackId}-display`, type: 'LinearBasicDisplay' }],
      }] : []), {
        trackId,
        name: 'RAPPTOR raw scores (+ / - strands)',
        metadata: { rapptorMirroredScore: true },
        assemblyNames: [assemblyName],
        type: 'MultiQuantitativeTrack',
        adapter: {
          type: 'MultiWiggleAdapter',
          subadapters: [
            { type: 'BigWigAdapter', source: 'plus', name: '+ strand', bigWigLocation: { uri: `${base}/scores.plus.bw` } },
            { type: 'BigWigAdapter', source: 'minus', name: '- strand', bigWigLocation: { uri: `${base}/scores.minus.bw` } },
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
      }],
      plugins: [RapptorMirroredScorePlugin],
      location: `${refName}:1-10000`,
      defaultSession: {
        name: `${assemblyName} result`,
        view: {
          id: `${assemblyName}-linear-view`,
          type: 'LinearGenomeView',
          tracks: [{
            type: 'ReferenceSequenceTrack',
            configuration: sequenceTrackId,
            displays: [{
              type: 'LinearReferenceSequenceDisplay',
              configuration: `${sequenceTrackId}-LinearReferenceSequenceDisplay`,
              heightPreConfig: 90,
            }],
          }, ...(annotation ? [{
            type: 'FeatureTrack',
            configuration: annotationTrackId,
            displays: [{ type: 'LinearBasicDisplay', configuration: `${annotationTrackId}-display`, heightPreConfig: 150 }],
          }] : []), {
            type: 'MultiQuantitativeTrack',
            configuration: trackId,
            displays: [{ type: 'MultiLinearWiggleDisplay', configuration: `${trackId}-display` }],
          }],
        },
      },
    });
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
    <div className="portal-browser"><RapptorJBrowseLinearView viewState={viewState} /></div>
  </>;
}
