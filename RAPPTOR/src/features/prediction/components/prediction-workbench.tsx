'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import {
  parsePredictionHistory,
  PREDICTION_HISTORY_KEY,
  upsertPredictionHistory,
  type PredictionHistoryEntry,
} from '../history';
import FocusedJobResult from './focused-job-result';
import PredictionProgressPanel from './prediction-progress-panel';
import { normalizePredictionProgress } from '../progress';
import { PORTAL_TERMS } from '@/components/portal-terminology';
import styles from '../prototype-result.module.css';

const PredictionBrowser = dynamic(() => import('./prediction-browser'), { ssr: false });

type Artifact = { filename: string; format: string; size_bytes: number; sha256: string };
type JobSummary = {
  mode?: 'genome_scan' | 'predict';
  total_bases?: number;
  contig_count?: number;
  stride?: number;
  window_count?: number;
  passing_window_count?: number;
  sequence_bases?: number;
  genome_context_bases?: number;
  max_score?: number;
  reverse_complementary?: boolean;
  model?: { model_version?: string; checkpoint_sha256?: string; model_asset_status?: string };
};
type JobState = {
  job_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  model_version?: string;
  progress?: { stage?: string; percent?: number; contig?: string; strand?: string; windows?: number };
  submitted_at?: string;
  artifacts_expires_at?: string | null;
  result?: { artifacts?: Artifact[] };
  error?: { type?: string; message?: string };
};

function formatDate(value?: string | null) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBases(value?: number) {
  return value === undefined ? 'Not recorded' : `${value.toLocaleString()} bp`;
}

function resultEntry(jobId: string, stored: PredictionHistoryEntry[]): PredictionHistoryEntry | null {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
  const sharedToken = fragment.get('access');
  const sharedReference = fragment.get('ref')?.slice(0, 200) || '';
  if (sharedToken && /^[A-Za-z0-9_-]{32,200}$/u.test(sharedToken)) {
    return {
      jobId,
      token: sharedToken,
      refName: sharedReference,
      status: 'unknown',
      mode: fragment.get('mode') === 'predict' ? 'predict' : 'genome_scan',
      submittedAt: new Date().toISOString(),
      label: sharedReference || `Shared task ${jobId.slice(0, 8)}`,
      bases: 0,
    };
  }
  const historyEntry = stored.find((item) => item.jobId === jobId);
  if (historyEntry) return historyEntry;
  try {
    const sessionEntry = JSON.parse(sessionStorage.getItem('rapptor-prediction-job') || 'null') as PredictionHistoryEntry | null;
    return sessionEntry?.jobId === jobId && sessionEntry.token ? sessionEntry : null;
  } catch {
    return null;
  }
}

function MissingTask({ message }: { message: string }) {
  return <main className={styles.missing}><div>
    <ErrorOutlineRoundedIcon aria-hidden="true" />
    <p className="portal-kicker">Prediction result unavailable</p>
    <h1>This task cannot be opened</h1>
    <p>{message}</p>
    <div className={styles.missingActions}><Link className="portal-button portal-button-primary" href="/predict">Create another prediction</Link></div>
  </div></main>;
}

export default function PredictionWorkbench({ initialJobId }: { initialJobId: string }) {
  const [entry, setEntry] = useState<PredictionHistoryEntry | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [resolvedRefName, setResolvedRefName] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const stored = parsePredictionHistory(localStorage.getItem(PREDICTION_HISTORY_KEY));
    const saved = resultEntry(initialJobId, stored);
    if (!saved) {
      setMessage('The access link is incomplete, expired, or is not stored in this browser.');
      setLoaded(true);
      return;
    }
    sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(saved));
    setEntry(saved);
    setLoaded(true);
  }, [initialJobId]);

  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/predictions/jobs/${entry.jobId}`, { headers: { 'X-Job-Token': entry.token }, cache: 'no-store' });
        if (!response.ok) throw new Error('This prediction is unavailable or its temporary files have expired.');
        const next = await response.json() as JobState;
        if (next.status === 'succeeded') {
          const session = await fetch(`/api/predictions/jobs/${entry.jobId}/session`, { method: 'POST', headers: { 'X-Job-Token': entry.token } });
          if (!session.ok) throw new Error('Task access is invalid or has expired. Reopen a valid protected task link.');
        }
        if (cancelled) return;
        setJob(next);
        setMessage('');
        const updated = { ...entry, status: next.status };
        localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify(upsertPredictionHistory(parsePredictionHistory(localStorage.getItem(PREDICTION_HISTORY_KEY)), updated)));
        sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(updated));
        if (next.status === 'queued' || next.status === 'running' || next.status === 'unknown') timer = window.setTimeout(load, 3000);
      } catch (cause) {
        if (!cancelled) {
          setMessage(cause instanceof Error ? cause.message : 'Prediction status could not be loaded.');
          timer = window.setTimeout(load, 3000);
        }
      }
    };
    void load();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [entry]);

  const artifacts = useMemo(() => job?.result?.artifacts || [], [job?.result?.artifacts]);

  useEffect(() => {
    setSummary(null);
    if (job?.status !== 'succeeded') return;
    const controller = new AbortController();
    const fetchArtifact = async <T,>(filename: string) => {
      const response = await fetch(`/api/predictions/jobs/${job.job_id}/artifacts/${filename}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load ${filename}.`);
      return response.json() as Promise<T>;
    };
    if (!artifacts.some((artifact) => artifact.filename === 'summary.json')) {
      setMessage('The completed task has no summary.json artifact.');
      return;
    }
    void fetchArtifact<JobSummary>('summary.json').then((nextSummary) => {
      if (!controller.signal.aborted) setSummary(nextSummary);
    }).catch((cause) => {
      if (!controller.signal.aborted) setMessage(cause instanceof Error ? cause.message : 'Result files could not be loaded.');
    });
    return () => controller.abort();
  }, [artifacts, job?.job_id, job?.status]);

  useEffect(() => {
    if (job?.status !== 'succeeded' || entry?.refName || !artifacts.some((item) => item.filename === 'input.fasta.fai')) return;
    const controller = new AbortController();
    void fetch(`/api/predictions/jobs/${job.job_id}/artifacts/input.fasta.fai`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const id = (await response.text()).split('\n')[0]?.split('\t')[0];
        if (!id || /\s/.test(id)) throw new Error();
        if (!controller.signal.aborted) setResolvedRefName(id);
      }).catch(() => { if (!controller.signal.aborted) setMessage('The reference index is unavailable or invalid.'); });
    return () => controller.abort();
  }, [artifacts, entry?.refName, job?.job_id, job?.status]);

  if (!loaded) return <main className={styles.missing}><div><p className="portal-kicker">Prediction result</p><h1>Loading task…</h1></div></main>;
  if (!entry) return <MissingTask message={message} />;

  const mode = summary?.mode || entry.mode;
  const refName = entry.refName || resolvedRefName;
  const bothStrands = summary?.reverse_complementary !== false && entry.strandMode !== 'forward';
  const missingBrowserFiles = ['scores.plus.bw', 'input.fasta', 'input.fasta.fai', ...(bothStrands ? ['scores.minus.bw'] : [])].filter((name) => !artifacts.some((artifact) => artifact.filename === name));
  const hasReference = missingBrowserFiles.length === 0;
  const downloads = artifacts;
  const progress = normalizePredictionProgress({
    state: job?.status === 'unknown' ? 'running' : job?.status || 'queued',
    stage: job?.status === 'succeeded' ? 'complete' : job?.progress?.stage || job?.status || 'queued',
    percent: job?.progress?.percent ?? null,
    message: job?.error?.message || (job?.status === 'succeeded' ? 'Result ready.' : job?.status === 'queued' ? 'Waiting for an available worker.' : 'Loading prediction status…'),
    contig: job?.progress?.contig,
    strand: job?.progress?.strand === '+' || job?.progress?.strand === '-' ? job.progress.strand : undefined,
    windows: job?.progress?.windows,
  });

  return <main className={styles.page}>
    <div className={`portal-shell ${styles.shell}`}>
      <header className={styles.intro}>
        <div className={styles.introCopy}>
          <p className="portal-kicker">{mode === 'predict' ? '100 bp scoring' : PORTAL_TERMS.sequenceScan}</p>
          <h1>Prediction result</h1>
          <p>{mode === 'predict' ? 'Compare the model score for each evaluated strand.' : 'Explore model-score and promoter-prediction tracks in the genome browser.'}</p>
        </div>
        <div className={styles.runMeta}><span>Live task</span><code>{entry.jobId}</code><small>{formatDate(job?.submitted_at || entry.submittedAt)}</small></div>
      </header>

      {message && <div className={styles.resultError} role="alert"><ErrorOutlineRoundedIcon aria-hidden="true" /><span>{message}</span></div>}
      <PredictionProgressPanel mode={mode === 'predict' ? 'focused' : 'scan'} snapshot={progress} />

      {job?.status === 'succeeded' && summary ? <>
        {mode === 'predict' ? <FocusedJobResult jobId={entry.jobId} bothStrands={bothStrands} hasScores={artifacts.some((item) => item.filename === 'scores.json')} /> : <>
          <section className={styles.summary} aria-label="Sequence scan summary">
            <div><span>Sequences</span><strong>{summary.contig_count?.toLocaleString() ?? '—'}</strong><small>Scanned contigs</small></div>
            <div><span>Scored windows</span><strong>{summary.window_count?.toLocaleString() ?? '—'}</strong><small>Model evaluations</small></div>
            <div><span>Promoter predictions</span><strong>{summary.passing_window_count?.toLocaleString() ?? '—'}</strong><small>Above export cutoff</small></div>
          </section>
          {!hasReference ? <p role="alert">Required browser artifacts are missing: {missingBrowserFiles.join(', ')}.</p> : null}
          {hasReference && refName ? <section className={styles.panel} aria-labelledby="genome-browser-heading">
            <div className={styles.panelHeader}><h2 id="genome-browser-heading">Genome browser</h2><p>Reference sequence and model-score tracks from this completed scan.</p></div>
            <PredictionBrowser jobId={entry.jobId} refName={refName} artifacts={artifacts} />
          </section> : null}
        </>}

        {downloads.length ? <section className={styles.panel} aria-labelledby="download-heading">
          <div className={styles.panelHeader}><h2 id="download-heading">Download result</h2><p>Temporary result files are available until {formatDate(job.artifacts_expires_at)}.</p></div>
          <div className={styles.downloads}>{downloads.map((artifact) => <a className={styles.downloadButton} key={artifact.filename} href={`/api/predictions/jobs/${entry.jobId}/artifacts/${artifact.filename}`} download>
            <DownloadRoundedIcon aria-hidden="true" /><span>{artifact.format.toUpperCase()}<small>{artifact.filename}</small></span>
          </a>)}</div>
        </section> : null}

        <section className={styles.panel} aria-labelledby="run-context-heading">
          <div className={styles.panelHeader}><h2 id="run-context-heading">Run context</h2><p>This live result is available through its private temporary access link.</p></div>
          <dl className={styles.factGrid}>
            <div><dt>Input</dt><dd>{entry.label} · {formatBases(mode === 'predict' ? summary.sequence_bases : summary.total_bases)}</dd></div>
            <div><dt>Genome context</dt><dd>{formatBases(summary.genome_context_bases || summary.total_bases)}</dd></div>
            <div><dt>Analysis</dt><dd>{bothStrands ? 'Both strands requested' : 'Forward strand only'} · {entry.cutoff === undefined ? 'No export filtering' : `configured threshold ${entry.cutoff.toFixed(2)}`} · stride {summary.stride || entry.strideBases || 1} bp</dd></div>
            <div><dt>Model</dt><dd>{summary.model?.model_version || job.model_version || 'Model version unavailable'}</dd></div>
            <div><dt>Model status</dt><dd>{summary.model?.model_asset_status === 'candidate_not_production' ? 'Candidate model' : summary.model?.model_asset_status || 'Not reported'}</dd></div>
            <div><dt>Checkpoint SHA-256</dt><dd>{summary.model?.checkpoint_sha256 || 'Not reported'}</dd></div>
          </dl>
        </section>

        <aside className={styles.interpret} aria-labelledby="interpret-heading">
          <h2 id="interpret-heading">How to interpret this result</h2>
          <p>{mode === 'predict' ? 'Scores are shown for the strands returned by the service. Missing strands are reported explicitly.' : 'Higher scores identify stronger promoter-like windows; browser peaks remain model predictions.'} This result does not establish experimental support or a transcription start site.</p>
          <Link href="/predict">Start a new prediction</Link>
        </aside>
      </> : null}
    </div>
  </main>;
}
