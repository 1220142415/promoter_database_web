'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import {
  normalizePredictionProgress,
  predictionProgressStepIndex,
  predictionProgressSteps,
  type PredictionProgressMode,
  type PredictionProgressSnapshot,
} from '../progress';
import styles from './prediction-progress.module.css';

function queueCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsed(start: number | null, end: number | null) {
  if (start === null || end === null || end < start) return null;
  return end - start;
}

function formatDuration(value: number | null) {
  if (value === null) return '—';
  const seconds = Math.floor(value / 1_000);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  if (hours < 24) return `${hours}h ${minuteRemainder}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export default function PredictionProgressPanel({
  mode,
  snapshot,
  onRetry,
}: {
  mode: PredictionProgressMode;
  snapshot: PredictionProgressSnapshot;
  onRetry?: () => void;
}) {
  const progress = normalizePredictionProgress(snapshot);
  const [now, setNow] = useState<number | null>(null);
  const steps = predictionProgressSteps(mode);
  const currentStep = predictionProgressStepIndex(progress);
  const failed = progress.state === 'failed';
  const queued = progress.state === 'queued' && !progress.simulated;
  const ahead = queueCount(progress.queue?.ahead);
  const running = queueCount(progress.queue?.running);
  const workerReady = progress.queue?.worker_ready;
  const busy = (running ?? 0) > 0 || (ahead ?? 0) > 0;
  const serverStatus = workerReady === false ? 'Temporarily unavailable'
    : busy ? 'Busy' : workerReady === true ? 'Available' : 'Status unavailable';
  const waitSeconds = progress.queue?.estimated_wait_seconds;
  const estimateAvailable = workerReady !== false && typeof waitSeconds === 'number' && Number.isFinite(waitSeconds) && waitSeconds >= 0;
  const waitLabel = estimateAvailable
    ? waitSeconds < 60 ? '<1 min' : `~${Math.ceil(waitSeconds / 60).toLocaleString()} min`
    : '—';
  const submittedAt = timestamp(progress.submittedAt);
  const startedAt = timestamp(progress.startedAt);
  const endedAt = timestamp(progress.endedAt);
  const active = progress.state === 'queued' || progress.state === 'running';
  const timingNow = now === null ? null : Math.max(now, submittedAt ?? now, startedAt ?? now);
  const hasTiming = submittedAt !== null || startedAt !== null || endedAt !== null;
  const timing = hasTiming ? {
    queue: elapsed(submittedAt, startedAt ?? (active ? timingNow : null)),
    processing: elapsed(startedAt, endedAt ?? (active ? timingNow : null)),
    total: elapsed(submittedAt, endedAt ?? (active ? timingNow : null)),
  } : null;
  const showScan = mode === 'scan' && progress.state !== 'succeeded' && currentStep >= 2
    && (progress.stage === 'scanning' || progress.windows !== undefined || progress.totalWindows !== undefined);
  const scanPercent = progress.scanPercent;
  const scanDetails = [
    progress.contig ? `Sequence: ${progress.contig}` : null,
    progress.strand ? (progress.strand === '+' ? 'Forward strand (+)' : 'Reverse strand (−)') : null,
  ].filter(Boolean);
  const details = [
    !showScan && progress.contig ? `Contig ${progress.contig}` : null,
    !showScan && progress.strand ? `${progress.strand} strand` : null,
    !showScan && typeof progress.windows === 'number' ? `${progress.windows.toLocaleString()} windows processed` : null,
  ].filter(Boolean);

  useEffect(() => {
    if (!active || !hasTiming) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, hasTiming, progress.submittedAt, progress.startedAt, progress.endedAt]);

  return (
    <section className={`${styles.panel} ${failed ? styles.failed : ''}`} aria-label="Prediction progress" data-state={progress.state}>
      <div className={styles.heading}>
        <div>
          <span>{progress.simulated ? 'Simulated queue preview' : 'Prediction task'}</span>
          <strong>{failed ? 'Prediction failed' : queued ? 'Your task is in the queue' : steps[currentStep].label}</strong>
        </div>
        <span className={styles.percent}>{failed ? 'Stopped' : queued ? 'Queued' : progress.percent === null ? 'In progress' : `${Math.round(progress.percent)}%`}{showScan && !failed && progress.percent !== null ? <small>overall</small> : null}</span>
      </div>

      <ol className={styles.steps} aria-label="Prediction stages">
        {steps.map((step, index) => {
          const complete = progress.state === 'succeeded' || index < currentStep;
          const current = index === currentStep && progress.state !== 'succeeded';
          return (
            <li className={complete ? styles.complete : current ? styles.current : ''} key={step.key} aria-current={current ? 'step' : undefined}>
              <i aria-hidden="true">{complete ? '✓' : index + 1}</i>
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>

      {queued ? <section className={styles.queue} aria-label="Queue status" aria-live="polite">
        <div className={styles.queueHeading}><strong>{mode === 'scan' ? 'Genome scan queue' : 'Short-sequence queue'}</strong><span data-busy={busy}>{serverStatus}</span></div>
        <dl className={styles.queueMetrics}>
          <div><dt>Running</dt><dd>{running ?? '—'}</dd></div>
          <div><dt>Queued ahead</dt><dd>{ahead ?? '—'}</dd></div>
          <div><dt title="Estimated wait until your task starts">Est. wait</dt><dd>{waitLabel}</dd></div>
        </dl>
      </section> : failed && progress.percent === null ? null : progress.percent === null
        ? <progress aria-label="Prediction task progress" max={100} />
        : <progress aria-label="Prediction task progress" max={100} value={progress.percent} />}
      {showScan ? <section className={styles.scan} aria-label="Genome scan progress">
        <div className={styles.scanHeading}>
          <strong>{failed ? 'Scan stopped' : progress.totalWindows === 0 ? 'No windows to scan' : currentStep > 2 ? 'Scan complete' : 'Scan progress'}</strong>
          <span>{progress.totalWindows === 0 ? '—' : scanPercent == null ? (failed ? 'Stopped' : 'In progress') : `${Math.floor(scanPercent * 10) / 10}%`}</span>
        </div>
        {progress.totalWindows === 0 ? null : scanPercent == null
          ? <progress aria-label="Scanned windows" max={100} />
          : <progress aria-label="Scanned windows" max={100} value={scanPercent} />}
        <div className={styles.scanCounts} aria-live="polite">
          <strong>{progress.windows?.toLocaleString() ?? '—'}{progress.totalWindows !== undefined ? ` / ${progress.totalWindows.toLocaleString()}` : ''}</strong>
          <span>windows scanned</span>
        </div>
        {scanDetails.length && currentStep === 2 ? <p>{scanDetails.join(' · ')}</p> : null}
        {progress.totalWindows === undefined ? <p>Total window count is not available from this service.</p> : null}
      </section> : null}
      {timing ? <section className={styles.timing} aria-label="Task timing">
        <div className={styles.timingHeading}><strong>Task timing</strong><span>{active ? 'Live' : 'Final'}</span></div>
        <dl className={styles.queueMetrics}>
          <div><dt>Queue time</dt><dd>{formatDuration(timing.queue)}</dd></div>
          <div><dt>Processing time</dt><dd>{formatDuration(timing.processing)}</dd></div>
          <div><dt>Total time</dt><dd>{formatDuration(timing.total)}</dd></div>
        </dl>
      </section> : null}
      {!queued && <div className={styles.status} role="status" aria-live="polite">
        {failed ? <ErrorOutlineRoundedIcon aria-hidden="true" /> : null}
        <div><strong>{progress.message}</strong>{details.length ? <span>{details.join(' · ')}</span> : null}</div>
      </div>}
      {progress.simulated ? <p className={styles.simulatedNote}>Demo only: simulated queue stages; no model was run.</p> : null}
      {failed ? <div className={styles.actions}>{onRetry ? <button type="button" onClick={onRetry}>Check status again</button> : null}<Link href="/predict">Return to prediction input</Link></div> : null}
    </section>
  );
}
