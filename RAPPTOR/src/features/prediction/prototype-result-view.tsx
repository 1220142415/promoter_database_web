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
import styles from './prototype-result.module.css';

const PrototypePredictionBrowser = dynamic(() => import('./prototype/prototype-browser'), {
  ssr: false,
  loading: () => <p role="status">Preparing browser-local tracks…</p>,
});

function formatScore(value: number) {
  return value.toFixed(3);
}

function formatLength(value: number | null) {
  return value === null ? 'Not provided' : `${value.toLocaleString()} nt`;
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
        <h2 id="focused-score-heading">Focused 100 bp result</h2>
        <p>Raw scores for each evaluated strand. The cutoff only marks whether a score passes.</p>
      </div>
      <div className={styles.focusedComparison} data-count={windows.length}>
        {windows.map((window) => {
          const aboveCutoff = window.score > run.parameters.cutoff;
          const strandName = window.strand === '+' ? 'Forward strand (+)' : 'Reverse strand (−)';
          return (
            <article className={styles.focusedStrandRow} key={window.strand}>
              <div className={styles.focusedStrandHeading}>
                <span>{strandName}</span>
                <strong className={aboveCutoff ? styles.passes : styles.below}>{aboveCutoff ? 'Above cutoff' : 'At or below cutoff'}</strong>
              </div>
              <div className={styles.focusedStrandSummary}>
                <strong>{formatScore(window.score)}</strong>
                <small>Illustrative raw score</small>
              </div>
              <div className={styles.focusedMeterArea}>
                <div className={styles.focusedMeter} role="meter" aria-label={`${strandName} illustrative raw score`} aria-valuemin={0} aria-valuemax={1} aria-valuenow={window.score}>
                  <i className={styles.focusedMeterFill} style={{ width: `${window.score * 100}%` }} />
                  <b className={styles.focusedCutoff} style={{ left: `${run.parameters.cutoff * 100}%` }} />
                </div>
                <div className={styles.focusedMeterLegend} aria-hidden="true"><span>0</span><span>Cutoff {run.parameters.cutoff.toFixed(2)}</span><span>1</span></div>
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
    { format: 'gff3', label: 'GFF3', detail: run.mode === 'candidate' ? 'Focused 100 bp strand windows' : 'Called peak features' },
    { format: 'bedgraph', label: 'bedGraph', detail: run.mode === 'candidate' ? 'Raw strand scores' : 'Raw window-score tracks' },
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
        <p>Prototype runs live only in this tab&apos;s session storage. They disappear when the session is cleared, and a copied result URL does not contain the input. No model was run.</p>
        <div className={styles.missingActions}>
          <Link className="portal-button portal-button-primary" href="/predict">Create another prototype run</Link>
          <Link className="portal-button portal-button-secondary" href="/help/prediction#results">Read prediction help</Link>
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
    return <main className={styles.missing}><div><p className="portal-kicker">Prototype result</p><h1>Loading result…</h1><p>No model was run. Loading the deterministic fixture stored for this tab.</p></div></main>;
  }
  if (!run || !fixture || !progress) return <MissingRun />;

  const genomeContext = run.input.genomeContext;
  const sequenceCount = run.mode === 'genome-scan' ? new Set(fixture.scoreSeries.map((point) => point.sequenceId)).size : 0;

  return (
    <main className={styles.page}>
      <div className={`portal-shell ${styles.shell}`}>
        <header className={styles.intro}>
          <div className={styles.introCopy}>
            <p className="portal-kicker">{run.mode === 'candidate' ? 'Focused 100 bp scoring' : 'Sequence / contig scan'}</p>
            <h1>Prediction result</h1>
            <p>{run.mode === 'candidate' ? 'Compare strand-specific raw scores, cutoff states and anchor positions for one submitted window.' : 'Explore illustrative raw-score and called-peak tracks in the genome browser.'}</p>
          </div>
          <div className={styles.runMeta}><span>Prototype run</span><code>{run.runId}</code><small>{formatCreatedAt(run.createdAt)}</small></div>
        </header>

        <div className={styles.prototypeBanner} role="note">
          <ScienceRoundedIcon aria-hidden="true" />
          <div><strong>No model was run</strong><span>Every value below is a deterministic interface fixture for previewing the workflow. It is not a biological prediction or experimental result.</span></div>
        </div>

        <PredictionProgressPanel mode={run.mode === 'candidate' ? 'focused' : 'scan'} snapshot={progress} />

        {progress.state === 'succeeded' ? <>
        {run.mode === 'candidate' ? <FocusedSequenceResult run={run} fixture={fixture} /> : (
          <>
            <section className={styles.summary} aria-label="Genome scan summary">
              <div><span>Sequences</span><strong>{sequenceCount}</strong><small>Illustrative contigs</small></div>
              <div><span>Raw score windows</span><strong>{fixture.windows.length.toLocaleString()}</strong><small>Illustrative fixture values</small></div>
              <div><span>Called peaks</span><strong>{fixture.calledPeaks.length.toLocaleString()}</strong><small>Illustrative post-processing</small></div>
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
            <p>GFF3 contains strand-aware {run.mode === 'candidate' ? 'focused windows' : 'called peaks'} using 1-based coordinates. bedGraph contains strand-separated raw scores using zero-based, half-open intervals.</p>
          </div>
          <Downloads run={run} fixture={fixture} />
        </section>

        <section className={styles.panel} aria-labelledby="run-context-heading">
          <div className={styles.panelHeader}><h2 id="run-context-heading">Run context</h2><p>Only metadata is restored from session storage. A scan can show its submitted reference during this tab&apos;s navigation; after refresh, the browser uses an illustrative local fallback.</p></div>
          <dl className={styles.factGrid}>
            <div><dt>Input</dt><dd>{run.mode === 'candidate' ? `${run.input.displayName} · ${run.input.length.toLocaleString()} nt` : run.input.scanSource.fileName || run.input.scanSource.displayName}</dd></div>
            <div><dt>Genome context</dt><dd>{genomeContext.displayName} · {formatLength(genomeContext.totalLength)}</dd></div>
            <div><dt>Analysis</dt><dd>{run.parameters.strandMode === 'both' ? 'Both strands' : 'Forward strand only'} · cutoff {run.parameters.cutoff.toFixed(2)} · step {run.parameters.strideBases} nt</dd></div>
            <div><dt>Model</dt><dd>100 nt window · 80/20 anchor · CGR 128×128 · {run.modelSpec.version}</dd></div>
          </dl>
        </section>

        <aside className={styles.interpret} aria-labelledby="interpret-heading">
          <h2 id="interpret-heading">How to interpret this result</h2>
          <p>{run.mode === 'candidate' ? 'Each raw score belongs to the same focused 100 bp input read in one orientation. The cutoff only labels the score state; no ranking or post-processing is applied.' : 'A higher raw score means an illustrative scan window ranks higher within the fixture. A called peak is a post-processed candidate anchor, not a separate model score.'} The result does not establish accuracy, experimental support, or a transcription start site.</p>
          <Link href="/help/prediction#results">Read the interpretation guide</Link>
        </aside>
        </> : null}
      </div>
    </main>
  );
}
