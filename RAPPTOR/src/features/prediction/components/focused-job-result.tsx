'use client';

import { useEffect, useState } from 'react';
import { parseFocusedScores, type FocusedScore } from '../focused-scores';
import styles from './prediction.module.css';

export default function FocusedJobResult({ jobId, bothStrands, hasScores }: { jobId: string; bothStrands: boolean; hasScores: boolean }) {
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
        const partialForward = bothStrands && Array.isArray(data) && data.length === 1;
        const rows = parseFocusedScores(data, partialForward ? false : bothStrands);
        if (!controller.signal.aborted) setScores(rows);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Score data unavailable.'); });
    return () => controller.abort();
  }, [jobId, bothStrands, hasScores, revision]);
  return <section className={styles.jobSection} aria-label="100 bp result">
    <div className={styles.panelHeading}><div><p className="portal-kicker">100 bp scoring</p><h2>100 bp result</h2></div></div>
    {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>Retry score download</button></div>
      : scores ? <>
        {bothStrands && scores.length === 1 ? <p role="alert">The service returned only the forward-strand score. The reverse-strand result is missing; two-strand verification did not pass.</p> : null}
        <div className={styles.resultSummary}>{scores.map((row) => <div key={row.strand}>
        <span>{row.strand === '+' ? 'Forward strand (+)' : 'Reverse strand (−)'}</span>
        <strong>{row.score.toFixed(6)}</strong><small>Model score</small>
        <meter aria-label={`${row.strand === '+' ? 'Forward' : 'Reverse'} strand model score`} min={0} max={1} value={row.score} />
      </div>)}</div></> : <p role="status">Loading model scores…</p>}
  </section>;
}
