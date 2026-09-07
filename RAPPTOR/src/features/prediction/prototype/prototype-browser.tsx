'use client';

import { useEffect, useMemo, useState } from 'react';
import UnifiedBrowserPanel from '@/features/genome-browser/components/unified-browser-panel';
import type { JBrowseAssemblyConfig } from '@/features/genome-browser/types';
import type {
  PrototypeGenomeScanRun,
  PrototypePredictionFixture,
  PrototypeScoreWindow,
} from './types';
import { readPrototypeTransientInput } from './transient-input';
import styles from './prototype-browser.module.css';

type BrowserReferenceRecord = {
  sequenceId: string;
  sequence: string;
};

type BrowserObjectUrls = {
  fasta: string;
  rawScoresPlus: string;
  rawScoresMinus: string | null;
  calledPeaks: string;
  records: BrowserReferenceRecord[];
  source: 'submitted' | 'illustrative';
};

const FASTA_LINE_WIDTH = 80;
function referenceRecords(run: PrototypeGenomeScanRun) {
  const submitted = readPrototypeTransientInput(run.runId);
  if (submitted?.records.length) {
    return {
      source: 'submitted' as const,
      records: submitted.records.map((record) => ({ sequenceId: record.sequenceId, sequence: record.normalizedSequence })),
    };
  }

  throw new Error('The reference sequence is no longer available in this tab. Reload the example or upload its FASTA again.');
}

function fastaText(records: readonly BrowserReferenceRecord[]) {
  const lines: string[] = [];
  records.forEach(({ sequenceId, sequence }) => {
    lines.push(`>${sequenceId}\n`);
    for (let offset = 0; offset < sequence.length; offset += FASTA_LINE_WIDTH) {
      lines.push(sequence.slice(offset, offset + FASTA_LINE_WIDTH), '\n');
    }
  });
  return lines.join('');
}

function bedGraphText(points: readonly PrototypeScoreWindow[], strand: '+' | '-') {
  return points
    .filter((point) => point.strand === strand)
    .sort((left, right) => left.sequenceId.localeCompare(right.sequenceId) || left.windowStart - right.windowStart)
    .map((point) => `${point.sequenceId}\t${point.windowStart - 1}\t${point.windowEnd}\t${point.score.toFixed(3)}`)
    .join('\n');
}

function gff3Value(value: string | number) {
  return encodeURIComponent(String(value)).replace(/%20/gu, '+');
}

function gff3Text(fixture: PrototypePredictionFixture, records: readonly BrowserReferenceRecord[]) {
  const availableReferences = new Set(records.map((record) => record.sequenceId));
  const directives = records.map((record) => `##sequence-region ${record.sequenceId} 1 ${record.sequence.length}`);
  const features = fixture.calledPeaks
    .filter((peak) => availableReferences.has(peak.sequenceId))
    .sort((left, right) => left.sequenceId.localeCompare(right.sequenceId) || left.anchor - right.anchor || left.strand.localeCompare(right.strand))
    .map((peak, index) => [
      peak.sequenceId,
      'RAPPTOR_prototype',
      'called_peak',
      peak.anchor,
      peak.anchor,
      peak.smoothedScore.toFixed(3),
      peak.strand,
      '.',
      [
        `ID=illustrative_called_peak_${index + 1}`,
        'Name=Illustrative+called+peak',
        `raw_score=${gff3Value(peak.rawScore.toFixed(3))}`,
        `smoothed_score=${gff3Value(peak.smoothedScore.toFixed(3))}`,
        `anchor=${gff3Value(peak.anchor)}`,
        `window_start=${gff3Value(peak.windowStart)}`,
        `window_end=${gff3Value(peak.windowEnd)}`,
      ].join(';'),
    ].join('\t'));
  return ['##gff-version 3', ...directives, ...features, ''].join('\n');
}

function createObjectUrls(run: PrototypeGenomeScanRun, fixture: PrototypePredictionFixture): BrowserObjectUrls {
  const { source, records } = referenceRecords(run);
  const plusScores = bedGraphText(fixture.scoreSeries, '+');
  const minusScores = bedGraphText(fixture.scoreSeries, '-');
  return {
    fasta: URL.createObjectURL(new Blob([fastaText(records)], { type: 'text/x-fasta;charset=utf-8' })),
    rawScoresPlus: URL.createObjectURL(new Blob([plusScores], { type: 'text/plain;charset=utf-8' })),
    rawScoresMinus: minusScores
      ? URL.createObjectURL(new Blob([minusScores], { type: 'text/plain;charset=utf-8' }))
      : null,
    calledPeaks: URL.createObjectURL(new Blob([gff3Text(fixture, records)], { type: 'text/x-gff3;charset=utf-8' })),
    records,
    source,
  };
}

function revokeObjectUrls(urls: BrowserObjectUrls) {
  [urls.fasta, urls.rawScoresPlus, urls.rawScoresMinus, urls.calledPeaks]
    .filter((url): url is string => Boolean(url))
    .forEach((url) => URL.revokeObjectURL(url));
}

function defaultLocus(records: readonly BrowserReferenceRecord[]) {
  const reference = records.find((record) => record.sequence.length >= 100) || records[0];
  if (!reference) return 'illustrative_contig:1-100';
  return `${reference.sequenceId}:1-${Math.max(1, Math.min(10_000, reference.sequence.length))}`;
}

/**
 * Build the isolated JBrowse configuration after object URLs have been made.
 * Exported for narrow component tests; it never receives or returns raw DNA.
 */
export function createPrototypeBrowserAssembly(
  run: PrototypeGenomeScanRun,
  urls: Pick<BrowserObjectUrls, 'fasta' | 'rawScoresPlus' | 'rawScoresMinus' | 'calledPeaks' | 'records' | 'source'>,
  requestedLocus?: string,
): JBrowseAssemblyConfig {
  const sourceLabel = urls.source === 'submitted'
    ? 'Submitted reference sequence (this tab only)'
    : 'Illustrative reference sequence';
  return {
    assemblyName: `prototype-${run.runId}`,
    defaultLocus: requestedLocus || defaultLocus(urls.records),
    assetBase: '',
    adapterMode: 'unindexed',
    allowShareView: false,
    assets: {
      fasta: urls.fasta,
      fastaFai: '',
      fastaGzi: '',
      predictedPromoters: '',
      predictedPromotersIndex: '',
      promoterScoresPlus: null,
      promoterScoresMinus: null,
      ncbiAnnotations: null,
      ncbiAnnotationsIndex: null,
    },
    trackLabels: { reference: sourceLabel },
    prototypeTracks: {
      rawScoresBedGraphPlus: urls.rawScoresPlus,
      rawScoresBedGraphMinus: urls.rawScoresMinus,
      calledPeaksGff3: urls.calledPeaks,
      rawScoresLabel: 'Illustrative model scores (+ / − strands)',
      calledPeaksLabel: 'Illustrative promoter predictions',
    },
  };
}

function usePrototypeBrowserAssets(run: PrototypeGenomeScanRun, fixture: PrototypePredictionFixture) {
  const [urls, setUrls] = useState<BrowserObjectUrls | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    try {
      const next = createObjectUrls(run, fixture);
      setUrls(next);
      return () => revokeObjectUrls(next);
    } catch (cause) {
      setUrls(null);
      setError(cause instanceof Error ? cause.message : 'Reference sequence unavailable.');
    }
  }, [fixture, run]);

  return { urls, error };
}

function locusForContig(record: BrowserReferenceRecord, fixture: PrototypePredictionFixture) {
  const strongestPeak = fixture.calledPeaks
    .filter((peak) => peak.sequenceId === record.sequenceId)
    .sort((left, right) => right.smoothedScore - left.smoothedScore || right.rawScore - left.rawScore)[0];
  if (!strongestPeak) {
    return `${record.sequenceId}:1-${Math.max(1, Math.min(10_000, record.sequence.length))}`;
  }
  const start = Math.max(1, strongestPeak.anchor - 500);
  const end = Math.min(record.sequence.length, strongestPeak.anchor + 500);
  return `${record.sequenceId}:${start}-${Math.max(start, end)}`;
}

export interface PrototypePredictionBrowserProps {
  run: PrototypeGenomeScanRun;
  fixture: PrototypePredictionFixture;
}

export default function PrototypePredictionBrowser({ run, fixture }: PrototypePredictionBrowserProps) {
  const { urls, error } = usePrototypeBrowserAssets(run, fixture);
  const [selectedContig, setSelectedContig] = useState('');
  const [requestedLocus, setRequestedLocus] = useState<string | undefined>();
  const [browserRevision, setBrowserRevision] = useState(0);
  const availableContigs = urls?.records || [];
  const defaultContig = availableContigs.find((record) => record.sequence.length >= 100) || availableContigs[0];
  const activeContig = availableContigs.find((record) => record.sequenceId === selectedContig) || defaultContig;
  useEffect(() => {
    setSelectedContig(defaultContig?.sequenceId || '');
    setRequestedLocus(undefined);
    setBrowserRevision(0);
  }, [defaultContig?.sequenceId, run.runId]);

  const assembly = useMemo(
    () => urls ? createPrototypeBrowserAssembly(run, urls, requestedLocus || (activeContig ? locusForContig(activeContig, fixture) : undefined)) : null,
    [activeContig, fixture, requestedLocus, run, urls],
  );

  if (error) return <section className={styles.browser} aria-label="Genome browser"><p role="alert">{error}</p></section>;
  if (!assembly || !urls) {
    return <section className={styles.browser} aria-label="Genome browser"><p className={styles.loading} role="status">Preparing browser-local tracks…</p></section>;
  }

  const jumpToContig = (sequenceId: string) => {
    const record = availableContigs.find((candidate) => candidate.sequenceId === sequenceId);
    if (!record) return;
    setSelectedContig(sequenceId);
    setRequestedLocus(locusForContig(record, fixture));
    setBrowserRevision((value) => value + 1);
  };
  return (
    <section className={styles.browser} data-testid="prototype-prediction-browser" aria-label="Genome browser">
      <div className={styles.controls} aria-label="Genome browser controls">
        <label>
          <span>Contig</span>
          <select value={activeContig?.sequenceId || ''} onChange={(event) => jumpToContig(event.target.value)}>
            {availableContigs.map((record) => <option key={record.sequenceId} value={record.sequenceId}>{record.sequenceId} · {record.sequence.length.toLocaleString()} bp</option>)}
          </select>
        </label>
      </div>
      <div className={styles.viewer} key={`${run.runId}:${requestedLocus || ''}:${browserRevision}`}>
        <UnifiedBrowserPanel prediction={assembly} />
      </div>
    </section>
  );
}
