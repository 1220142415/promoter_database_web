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
  const details = [
    progress.contig ? `Contig ${progress.contig}` : null,
    progress.strand ? `${progress.strand} strand` : null,
    typeof progress.windows === 'number' ? `${progress.windows.toLocaleString()} windows processed` : null,
  ].filter(Boolean);

  return (
    <section className={`${styles.panel} ${failed ? styles.failed : ''}`} aria-label="Prediction progress" data-state={progress.state}>
      <div className={styles.heading}>
        <div>
          <span>{progress.simulated ? 'Simulated queue preview' : 'Prediction task'}</span>
          <strong>{failed ? 'Prediction failed' : steps[currentStep].label}</strong>
        </div>
        <span className={styles.percent}>{progress.percent === null ? 'In progress' : `${Math.round(progress.percent)}%`}</span>
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

      {progress.percent === null
        ? <progress aria-label="Prediction task progress" max={100} />
        : <progress aria-label="Prediction task progress" max={100} value={progress.percent} />}
      <div className={styles.status} role="status" aria-live="polite">
        {failed ? <ErrorOutlineRoundedIcon aria-hidden="true" /> : null}
        <div><strong>{progress.message}</strong>{details.length ? <span>{details.join(' · ')}</span> : null}</div>
      </div>
      {progress.simulated ? <p className={styles.simulatedNote}>Demo only: simulated queue stages; no model was run.</p> : null}
      {failed ? <div className={styles.actions}>{onRetry ? <button type="button" onClick={onRetry}>Check status again</button> : null}<Link href="/predict">Return to prediction input</Link></div> : null}
    </section>
  );
}
