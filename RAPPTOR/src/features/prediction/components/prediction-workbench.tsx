'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import {
  parsePredictionHistory,
  PREDICTION_HISTORY_KEY,
  upsertPredictionHistory,
  type PredictionHistoryEntry,
} from '../history';
import FocusedJobResult from './focused-job-result';
import PredictionProgressPanel from './prediction-progress-panel';
import ResultDownloads from './result-downloads';
import ResultInformation from './result-information';
import { windowCoordinateSystem, type JobArtifact, type JobSummary } from '../live-result';
import { normalizePredictionProgress, type PredictionQueueStatus } from '../progress';
import { PORTAL_TERMS } from '@/components/portal-terminology';
import styles from '../prototype-result.module.css';

const PredictionBrowser = dynamic(() => import('./prediction-browser'), { ssr: false });

type JobProgress = {
  stage?: string;
  percent?: number;
  contig?: string;
  strand?: string;
  windows?: number;
  total_windows?: number;
  scan_percent?: number;
  last_valid_progress?: JobProgress | null;
};

type JobState = {
  job_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  mode?: PredictionHistoryEntry['mode'];
  model_version?: string;
  progress?: JobProgress;
  submitted_at?: string;
  queue?: PredictionQueueStatus;
  artifacts_expires_at?: string | null;
  result?: { artifacts?: JobArtifact[] };
  error?: { code?: string; type?: string; message?: string };
};

export function predictionPollDelay(mode: PredictionHistoryEntry['mode'], elapsedMs: number, failed = false) {
  const delay = mode !== 'predict' ? 30_000 : elapsedMs < 20_000 ? 2_000 : elapsedMs < 60_000 ? 10_000 : 30_000;
  return failed ? Math.max(delay, 10_000) : delay;
}

function formatDate(value?: string | null) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function progressMessage(job: JobState | null) {
  if (!job) return 'Loading prediction status…';
  if (job.status === 'failed') {
    if (job.error?.code === 'JOB_PROGRESS_STALLED') return 'Prediction stopped because processing was no longer advancing.';
    if (job.error?.code === 'JOB_PROCESS_HEARTBEAT_LOST') return 'The prediction process stopped responding.';
    return job.error?.message || 'Prediction stopped before completion.';
  }
  if (job.error?.message) return job.error.message;
  if (job.status === 'succeeded') return 'Result ready.';
  if (job.status === 'queued') return 'Waiting for an available worker.';
  switch (job.progress?.stage) {
    case 'preparing_cgr': return 'Preparing genome CGR.';
    case 'scanning': return 'Scanning sequence windows.';
    case 'inference': return 'Scoring the input sequence.';
    case 'writing_outputs': return 'Scan finished. Preparing result files.';
    default: return 'Waiting for the next worker update.';
  }
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
    let finished = false;
    let loading = false;
    let resumeAfterLoad = false;
    const pollingStartedAt = Date.now();
    const schedule = (mode: PredictionHistoryEntry['mode'], failed = false) => {
      if (!cancelled && !finished && !document.hidden) {
        timer = window.setTimeout(load, predictionPollDelay(mode, Date.now() - pollingStartedAt, failed));
      }
    };
    const load = async () => {
      timer = undefined;
      if (cancelled || finished || loading || document.hidden) return;
      loading = true;
      try {
        const response = await fetch(`/api/predictions/jobs/${entry.jobId}`, { headers: { 'X-Job-Token': entry.token }, cache: 'no-store' });
        if (!response.ok) {
          if (!cancelled) {
            setMessage('This prediction is unavailable or its temporary files have expired.');
            if (response.status === 502 || response.status === 503) schedule(entry.mode, true);
            else finished = true;
          }
          return;
        }
        const next = await response.json() as JobState;
        if (next.status === 'succeeded') {
          const session = await fetch(`/api/predictions/jobs/${entry.jobId}/session`, { method: 'POST', headers: { 'X-Job-Token': entry.token } });
          if (!session.ok) {
            finished = true;
            if (!cancelled) setMessage('Task access is invalid or has expired. Reopen a valid protected task link.');
            return;
          }
        }
        if (cancelled) return;
        setJob(next);
        setMessage('');
        const updated = { ...entry, status: next.status, mode: next.mode || entry.mode };
        localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify(upsertPredictionHistory(parsePredictionHistory(localStorage.getItem(PREDICTION_HISTORY_KEY)), updated)));
        sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(updated));
        if (next.status === 'queued' || next.status === 'running' || next.status === 'unknown') {
          schedule(updated.mode);
        } else finished = true;
      } catch (cause) {
        if (!cancelled) {
          setMessage(cause instanceof Error ? cause.message : 'Prediction status could not be loaded.');
          schedule(entry.mode, true);
        }
      } finally {
        loading = false;
        if (resumeAfterLoad && !cancelled && !finished && !document.hidden) {
          resumeAfterLoad = false;
          void load();
        }
      }
    };
    const visibilityChanged = () => {
      if (document.hidden) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
      } else if (!finished) {
        if (loading) resumeAfterLoad = true;
        else void load();
      }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    void load();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', visibilityChanged);
      if (timer !== undefined) window.clearTimeout(timer);
    };
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
  const sequenceBases = summary?.sequence_bases || (entry.mode === 'predict' ? 100 : undefined);
  const focused = mode === 'predict' && sequenceBases === 100;
  const refName = entry.refName || resolvedRefName;
  const bothStrands = summary?.reverse_complementary ?? (entry.strandMode !== 'forward');
  const missingBrowserFiles = ['scores.plus.bw', 'input.fasta', 'input.fasta.fai', ...(bothStrands ? ['scores.minus.bw'] : [])].filter((name) => !artifacts.some((artifact) => artifact.filename === name));
  const hasReference = missingBrowserFiles.length === 0;
  const reportedProgress = job?.status === 'failed'
    ? job.progress?.last_valid_progress || job.progress
    : job?.progress;
  const progress = normalizePredictionProgress({
    state: job?.status === 'unknown' ? 'running' : job?.status || 'queued',
    stage: job?.status === 'succeeded' ? 'complete' : reportedProgress?.stage || job?.status || 'queued',
    percent: reportedProgress?.percent ?? job?.progress?.percent ?? null,
    message: progressMessage(job),
    contig: reportedProgress?.contig,
    strand: reportedProgress?.strand === '+' || reportedProgress?.strand === '-' ? reportedProgress.strand : undefined,
    windows: reportedProgress?.windows ?? summary?.window_count,
    totalWindows: reportedProgress?.total_windows ?? summary?.window_count,
    scanPercent: reportedProgress?.scan_percent,
    queue: job?.queue,
  });

  return <main className={styles.page}>
    <div className={`portal-shell ${styles.shell}`}>
      <header className={styles.intro}>
        <div className={styles.introCopy}>
          <p className="portal-kicker">{mode === 'predict' ? (focused ? '100 bp scoring' : 'Short-sequence prediction') : PORTAL_TERMS.sequenceScan}</p>
          <h1>Prediction result</h1>
          <p>{mode === 'predict' ? (focused ? 'Compare the model score for each evaluated strand.' : 'Review model scores from overlapping windows across the submitted sequence.') : 'Explore model-score tracks and download predicted window positions.'}</p>
        </div>
        <div className={styles.runMeta}><span>Live task</span><code>{entry.jobId}</code><small>{formatDate(job?.submitted_at || entry.submittedAt)}</small></div>
      </header>

      {message && <div className={styles.resultError} role="alert"><ErrorOutlineRoundedIcon aria-hidden="true" /><span>{message}</span></div>}
      <PredictionProgressPanel mode={mode === 'predict' ? 'focused' : 'scan'} snapshot={progress} />

      {job?.status === 'succeeded' && summary ? <>
        {mode === 'predict' ? <FocusedJobResult jobId={entry.jobId} bothStrands={bothStrands} hasScores={artifacts.some((item) => item.filename === 'scores.json')} sequenceBases={sequenceBases} threshold={entry.cutoff} coordinateSystem={windowCoordinateSystem(summary)} expiresAt={job.artifacts_expires_at ? formatDate(job.artifacts_expires_at) : undefined} /> : <>
          <section className={styles.summary} aria-label="Sequence scan summary">
            <div><span>Sequences</span><strong>{summary.contig_count?.toLocaleString() ?? '—'}</strong><small>Scanned contigs</small></div>
            <div><span>Scored windows</span><strong>{summary.window_count?.toLocaleString() ?? '—'}</strong><small>Model evaluations</small></div>
            {(summary.promoter_count ?? summary.peak_count) != null ? <div><span>Predicted promoters</span><strong>{(summary.promoter_count ?? summary.peak_count)!.toLocaleString()}</strong><small>Promoter prediction windows</small></div> : <div><span>Exported windows</span><strong>{summary.passing_window_count?.toLocaleString() ?? '—'}</strong><small>{summary.score_cutoff === null ? 'No export filtering' : summary.score_cutoff === undefined ? 'Export cutoff not recorded' : 'Above export cutoff'}</small></div>}
          </section>
          {!hasReference ? <p role="alert">Required browser artifacts are missing: {missingBrowserFiles.join(', ')}.</p> : null}
          {hasReference && refName ? <section className={styles.panel} aria-labelledby="genome-browser-heading">
            <div className={styles.panelHeader}><h2 id="genome-browser-heading">Genome browser</h2><p>Reference sequence and model-score tracks from this completed scan.</p></div>
            <PredictionBrowser jobId={entry.jobId} refName={refName} accessToken={entry.token} artifacts={artifacts} summary={summary} />
          </section> : null}
        </>}

        {!focused && artifacts.length > 0 && <ResultDownloads jobId={entry.jobId} artifacts={artifacts} mode={mode} expiresAt={formatDate(job.artifacts_expires_at)} bigwigSmoothing={summary.bigwig_smoothing} />}
        <ResultInformation summary={{ ...summary, mode, ...(mode === 'predict' && entry.cutoff !== undefined ? { score_cutoff: entry.cutoff, score_cutoff_operator: '>' } : {}) }} inputName={entry.label} refName={mode === 'genome_scan' ? refName : ''} />

        <aside className={styles.interpret} aria-labelledby="interpret-heading">
          <h2 id="interpret-heading">How to interpret this result</h2>
          <p>{mode === 'predict' ? 'Scores are shown for the strands returned by the service. Missing strands are reported explicitly.' : 'Higher scores identify stronger promoter-like windows; browser promoter predictions remain model predictions.'} This result does not establish experimental support or a transcription start site.</p>
          <Link href="/predict">Start a new prediction</Link>
        </aside>
      </> : null}
    </div>
  </main>;
}
