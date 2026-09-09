'use client';

import { useEffect, useState } from 'react';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import { parseSequenceScores, type FocusedScore } from '../focused-scores';
import { referenceWindow, RESULT_TABLE_FILENAME } from '../live-result';
import styles from './prediction.module.css';

export default function FocusedJobResult({ jobId, bothStrands, hasScores, sequenceBases = 100, threshold, coordinateSystem, expiresAt }: { jobId: string; bothStrands: boolean; hasScores: boolean; sequenceBases?: number; threshold?: number; coordinateSystem?: string; expiresAt?: string }) {
  const [scores, setScores] = useState<FocusedScore[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setScores(null); setError(null);
    if (!hasScores) { setError('The completed task has no scores.json artifact.'); return; }
    void fetch(`/api/predictions/jobs/${jobId}/artifacts/scores.json`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('The score artifact is unavailable or its access has expired.');
        const data = await response.json();
        // Older services can return only the forward score despite a both-strand
        // request. Display that validated observation with an explicit failure.
        const partialForward = bothStrands && Array.isArray(data) && data.length === sequenceBases - 99;
        const rows = parseSequenceScores(data, sequenceBases, partialForward ? false : bothStrands);
        if (!controller.signal.aborted) setScores(rows);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Score data unavailable.'); });
    return () => controller.abort();
  }, [jobId, bothStrands, hasScores, revision, sequenceBases]);
  const focused = sequenceBases === 100;
  const topScores = scores ? [...scores].sort((left, right) => right.score - left.score).slice(0, 20) : [];
  const passingStrands = focused && scores && threshold !== undefined
    ? scores.filter((row) => row.score > threshold).map((row) => row.strand)
    : null;
  return <section className={styles.jobSection} aria-label={focused ? '100 bp result' : 'Short-sequence result'}>
    <div className={`${styles.panelHeading} ${focused ? styles.focusedHeading : ''}`}>
      <div><p className="portal-kicker">{focused ? '100 bp scoring' : `${sequenceBases.toLocaleString()} bp sliding-window scoring`}</p><h2>{focused ? '100 bp result' : 'Short-sequence result'}</h2></div>
      {focused && hasScores ? <div className={styles.focusedDownload}>
        <a href={`/api/predictions/jobs/${jobId}/artifacts/${RESULT_TABLE_FILENAME}`} download>
          <DownloadRoundedIcon aria-hidden="true" />Download scores (TSV)
        </a>
        {expiresAt ? <small>Available until {expiresAt}</small> : null}
      </div> : null}
    </div>
    {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>Retry score download</button></div>
      : scores ? <>
        {bothStrands && !scores.some((row) => row.strand === '-') ? <p role="alert">The service returned only forward-strand scores. The reverse-strand result is missing; two-strand verification did not pass.</p> : null}
        {focused ? <>
          {passingStrands ? <div className={`${styles.focusedCall} ${passingStrands.length > 0 ? styles.focusedCallPositive : ''}`} role="status" aria-label="Model classification">
            <span>Model classification</span>
            <strong>{passingStrands.length > 0 ? 'Promoter' : 'Non-promoter'}</strong>
            <small>{passingStrands.length > 0
              ? `${passingStrands.map((strand) => strand === '+' ? 'Forward' : 'Reverse').join(' and ')} strand${passingStrands.length > 1 ? 's are' : ' is'} above the model threshold (> ${threshold}).`
              : `No evaluated strand is above the model threshold (> ${threshold}).`}</small>
          </div> : null}
          <div className={styles.resultSummary}>{scores.map((row) => {
            const passes = threshold !== undefined && row.score > threshold;
            return <div key={row.strand}>
              <span>{row.strand === '+' ? 'Forward strand (+)' : 'Reverse strand (−)'}</span>
              <strong>{row.score.toFixed(6)}</strong>
              <small>{threshold === undefined ? 'Model score' : `${passes ? 'Promoter' : 'Non-promoter'} · threshold ${passes ? '>' : '≤'} ${threshold}`}</small>
              <meter aria-label={`${row.strand === '+' ? 'Forward' : 'Reverse'} strand model score`} min={0} max={1} value={row.score} />
            </div>;
          })}</div>
        </> : <>
          <p>{scores.length.toLocaleString()} overlapping 100 bp windows were scored. The table shows the 20 highest model scores. Coordinates refer to the original input sequence.</p>
          <div className={styles.tableWrap}><table className={styles.windowTable}><thead><tr><th>Rank</th><th>Model score</th><th>Strand</th><th>Window (1-based)</th><th>Prediction anchor</th></tr></thead><tbody>{topScores.map((row, index) => {
            const window = referenceWindow(row.window_start_0based, row.strand, 100, sequenceBases, coordinateSystem)!;
            return <tr key={`${row.strand}-${row.window_start_0based}`}><td>{index + 1}</td><td>{row.score.toFixed(6)}</td><td>{row.strand}</td><td>{window.start}–{window.end}</td><td>{row.anchor_position_0based + 1}</td></tr>;
          })}</tbody></table></div>
        </>}
      </> : <p role="status">Loading model scores…</p>}
  </section>;
}
