'use client';

import Link from 'next/link';
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
      {!queued && <div className={styles.status} role="status" aria-live="polite">
        {failed ? <ErrorOutlineRoundedIcon aria-hidden="true" /> : null}
        <div><strong>{progress.message}</strong>{details.length ? <span>{details.join(' · ')}</span> : null}</div>
      </div>}
      {progress.simulated ? <p className={styles.simulatedNote}>Demo only: simulated queue stages; no model was run.</p> : null}
      {failed ? <div className={styles.actions}>{onRetry ? <button type="button" onClick={onRetry}>Check status again</button> : null}<Link href="/predict">Return to prediction input</Link></div> : null}
    </section>
  );
}
