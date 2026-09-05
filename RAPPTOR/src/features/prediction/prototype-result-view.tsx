'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded';
import PredictionProgressPanel from './components/prediction-progress-panel';
import { prototypePredictionProgressAt } from './progress';
import {
  createPrototypeFixture,
  readPrototypePredictionRun,
  type PrototypeCandidateRun,
  type PrototypePredictionFixture,
  type PrototypePredictionRun,
} from './prototype';
import {
  downloadPrototypeResult,
  type PrototypeDownloadFormat,
} from './prototype-result-downloads';
import { PORTAL_COPY, PORTAL_TERMS, predictionModeLabel, thresholdLabel } from '@/components/portal-terminology';
import styles from './prototype-result.module.css';

const PrototypePredictionBrowser = dynamic(() => import('./prototype/prototype-browser'), {
  ssr: false,
  loading: () => <p role="status">Preparing browser-local tracks…</p>,
});

function formatScore(value: number) {
  return value.toFixed(3);
}

function formatLength(value: number | null) {
  return value === null ? 'Not provided' : `${value.toLocaleString()} bp`;
}

function formatCreatedAt(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function focusedWindows(fixture: PrototypePredictionFixture) {
  return [...fixture.windows].sort((left, right) => left.strand === right.strand ? 0 : left.strand === '+' ? -1 : 1);
}

function FocusedSequenceResult({ run, fixture }: { run: PrototypeCandidateRun; fixture: PrototypePredictionFixture }) {
  const windows = focusedWindows(fixture);
  return (
    <section className={styles.panel} aria-labelledby="focused-score-heading">
      <div className={styles.panelHeader}>
        <h2 id="focused-score-heading">100 bp result</h2>
        <p>Model scores by strand. The model threshold classifies each score only.</p>
      </div>
      <div className={styles.focusedComparison} data-count={windows.length}>
        {windows.map((window) => {
          const aboveCutoff = window.score > run.parameters.cutoff;
          const strandName = window.strand === '+' ? 'Forward strand (+)' : 'Reverse strand (−)';
          return (
            <article className={styles.focusedStrandRow} key={window.strand}>
              <div className={styles.focusedStrandHeading}>
                <span>{strandName}</span>
                <strong className={aboveCutoff ? styles.passes : styles.below}>{aboveCutoff ? 'Above threshold' : 'At or below threshold'}</strong>
              </div>
              <div className={styles.focusedStrandSummary}>
                <strong>{formatScore(window.score)}</strong>
                <small>Illustrative model score</small>
              </div>
              <div className={styles.focusedMeterArea}>
                <div className={styles.focusedMeter} role="meter" aria-label={`${strandName} illustrative model score`} aria-valuemin={0} aria-valuemax={1} aria-valuenow={window.score}>
                  <i className={styles.focusedMeterFill} style={{ width: `${window.score * 100}%` }} />
                  <b className={styles.focusedCutoff} style={{ left: `${run.parameters.cutoff * 100}%` }} />
                </div>
                <div className={styles.focusedMeterLegend} aria-hidden="true"><span>0</span><span>Model threshold {run.parameters.cutoff.toFixed(2)}</span><span>1</span></div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Downloads({ run, fixture }: { run: PrototypePredictionRun; fixture: PrototypePredictionFixture }) {
  const downloads: Array<{ format: PrototypeDownloadFormat; label: string; detail: string }> = [
    { format: 'gff3', label: 'GFF3', detail: run.mode === 'candidate' ? '100 bp strand windows' : PORTAL_TERMS.promoterPredictions },
    { format: 'bedgraph', label: 'bedGraph', detail: run.mode === 'candidate' ? PORTAL_TERMS.rawModelScores : 'Raw model-score tracks' },
  ];
  return (
    <div className={styles.downloads} aria-label="Prototype result downloads">
      {downloads.map((item) => (
        <button aria-label={`Download ${item.label}`} className={styles.downloadButton} key={item.format} type="button" onClick={() => downloadPrototypeResult(run, fixture, item.format)}>
          <DownloadRoundedIcon aria-hidden="true" />
          <span>{item.label}<small>{item.detail}</small></span>
        </button>
      ))}
    </div>
  );
}

function MissingRun() {
  return (
    <main className={styles.missing}>
      <div>
        <ErrorOutlineRoundedIcon aria-hidden="true" />
        <p className="portal-kicker">Prototype result unavailable</p>
        <h1>This result is no longer in this tab</h1>
        <p>This run exists only in this tab&apos;s session storage. Clearing it removes the run, and copied URLs contain no input. No model was run.</p>
        <div className={styles.missingActions}>
          <Link className="portal-button portal-button-primary" href="/predict">Create another prototype run</Link>
        </div>
      </div>
    </main>
  );
}

export default function PrototypePredictionResultView({ runId }: { runId: string }) {
  const [run, setRun] = useState<PrototypePredictionRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [clock, setClock] = useState(0);

  useEffect(() => {
    setRun(readPrototypePredictionRun(runId));
    setClock(Date.now());
    setLoaded(true);
  }, [runId]);

  useEffect(() => {
    if (!run) return;
    const initialNow = Date.now();
    setClock(initialNow);
    if (prototypePredictionProgressAt(run, initialNow).state === 'succeeded') return;
    const timer = window.setInterval(() => {
      const nextNow = Date.now();
      setClock(nextNow);
      if (prototypePredictionProgressAt(run, nextNow).state === 'succeeded') window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, [run]);

  const fixture = useMemo(() => run ? createPrototypeFixture(run) : null, [run]);
  const progress = useMemo(() => run ? prototypePredictionProgressAt(run, clock || Date.now()) : null, [clock, run]);

  if (!loaded) {
    return <main className={styles.missing}><div><p className="portal-kicker">Prototype result</p><h1>Loading result…</h1><p>{PORTAL_COPY.demoNotice} Loading the fixture stored for this tab.</p></div></main>;
  }
  if (!run || !fixture || !progress) return <MissingRun />;

  const genomeContext = run.input.genomeContext;
  const sequenceCount = run.mode === 'genome-scan' ? new Set(fixture.scoreSeries.map((point) => point.sequenceId)).size : 0;

  return (
    <main className={styles.page}>
      <div className={`portal-shell ${styles.shell}`}>
        <header className={styles.intro}>
          <div className={styles.introCopy}>
            <p className="portal-kicker">{predictionModeLabel(run.mode === 'candidate' ? 'candidate' : 'genome-scan')}</p>
            <h1>Prediction result</h1>
            <p>{run.mode === 'candidate' ? 'Compare model scores, classifications, and anchors by strand.' : 'Explore illustrative model-score and promoter-prediction tracks.'}</p>
          </div>
          <div className={styles.runMeta}><span>Prototype run</span><code>{run.runId}</code><small>{formatCreatedAt(run.createdAt)}</small></div>
        </header>

        <div className={styles.prototypeBanner} role="note">
          <ScienceRoundedIcon aria-hidden="true" />
          <div><strong>{PORTAL_COPY.demoNotice}</strong></div>
        </div>

        <PredictionProgressPanel mode={run.mode === 'candidate' ? 'focused' : 'scan'} snapshot={progress} />

        {progress.state === 'succeeded' ? <>
        {run.mode === 'candidate' ? <FocusedSequenceResult run={run} fixture={fixture} /> : (
          <>
            <section className={styles.summary} aria-label="Sequence scan summary">
              <div><span>Sequences</span><strong>{sequenceCount}</strong><small>Illustrative contigs</small></div>
              <div><span>Scored windows</span><strong>{fixture.windows.length.toLocaleString()}</strong><small>Illustrative values</small></div>
              <div><span>Promoter predictions</span><strong>{fixture.calledPeaks.length.toLocaleString()}</strong><small>Illustrative post-processing</small></div>
            </section>

            <section className={styles.panel} aria-labelledby="genome-browser-heading">
              <div className={styles.panelHeader}>
                <h2 id="genome-browser-heading">Genome browser</h2>
              </div>
              <PrototypePredictionBrowser run={run} fixture={fixture} />
            </section>
          </>
        )}

        <section className={styles.panel} aria-labelledby="download-heading">
          <div className={styles.panelHeader}>
            <h2 id="download-heading">Download tracks</h2>
            <p>GFF3: strand-aware {run.mode === 'candidate' ? '100 bp windows' : 'promoter predictions'}, 1-based closed. bedGraph: strand-separated model scores, 0-based half-open.</p>
          </div>
          <Downloads run={run} fixture={fixture} />
        </section>

        <section className={styles.panel} aria-labelledby="run-context-heading">
          <div className={styles.panelHeader}><h2 id="run-context-heading">Run context</h2><p>Session storage restores metadata only. This tab can show the submitted reference until refresh; then an illustrative local reference is used.</p></div>
          <dl className={styles.factGrid}>
            <div><dt>Input</dt><dd>{run.mode === 'candidate' ? `${run.input.displayName} · ${run.input.length.toLocaleString()} bp` : run.input.scanSource.fileName || run.input.scanSource.displayName}</dd></div>
            <div><dt>Genome context</dt><dd>{genomeContext.displayName} · {formatLength(genomeContext.totalLength)}</dd></div>
            <div><dt>Analysis</dt><dd>{run.parameters.strandMode === 'both' ? 'Both strands' : 'Forward strand only'} · {thresholdLabel(run.mode === 'candidate' ? 'candidate' : 'genome-scan').toLowerCase()} {run.parameters.cutoff.toFixed(2)} · stride {run.parameters.strideBases} bp</dd></div>
            <div><dt>Model</dt><dd>100 bp window · 80/20 anchor · CGR 128×128 · {run.modelSpec.version}</dd></div>
          </dl>
        </section>

        <aside className={styles.interpret} aria-labelledby="interpret-heading">
          <h2 id="interpret-heading">How to interpret this result</h2>
          <p>{run.mode === 'candidate' ? 'Each strand has one score for the same 100 bp input. The model threshold changes classification only; no ranking or post-processing is applied.' : 'Higher scores rank windows within this fixture; promoter predictions are post-processed anchors, not new model scores.'} The result does not establish accuracy, experimental support, or a transcription start site.</p>
        </aside>
        </> : null}
      </div>
    </main>
  );
}
