'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  parsePredictionHistory,
  PREDICTION_HISTORY_KEY,
  upsertPredictionHistory,
  type PredictionHistoryEntry,
} from '../history';
import PredictionProgressPanel from './prediction-progress-panel';
import { normalizePredictionProgress, type PredictionProgressSnapshot } from '../progress';
import { formatPredictionMaxRequestBytes, predictionMaxRequestBytes } from '../capabilities';
import { PORTAL_TERMS } from '@/components/portal-terminology';
import styles from './prediction.module.css';

const PredictionBrowser = dynamic(() => import('./prediction-browser'), { ssr: false });

type Artifact = { filename: string; format: string; content_type?: string; size_bytes: number; sha256: string };
type JobSummary = {
  mode?: 'genome_scan' | 'predict';
  total_bases?: number;
  contig_count?: number;
  stride?: number;
  window_count?: number;
  sequence_bases?: number;
  genome_context_bases?: number;
  max_score?: number;
};
type JobState = {
  job_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  progress?: { stage?: string; percent?: number; contig?: string; strand?: string; windows?: number };
  submitted_at?: string;
  artifacts_expires_at?: string | null;
  result?: { artifacts?: Artifact[] };
  error?: { type?: string; message?: string };
};
type ApiError = { error?: { message?: string } };
type TicketResponse = ApiError & { ticket?: string };
type CreatedJobResponse = ApiError & {
  job_id?: string;
  access_token?: string;
  artifacts_expires_at?: string | null;
};

type TurnstileWidget = NonNullable<Window['turnstile']> & { reset?: (widgetId?: string) => void };

function fastaBases(value: string) {
  return value.split(/\r?\n/).reduce((total, line) => total + (line.startsWith('>') ? 0 : line.replace(/\s/g, '').length), 0);
}

function fastaSequence(value: string) {
  return value.split(/\r?\n/).filter((line) => !line.startsWith('>')).join('').replace(/\s/g, '');
}

function sequenceBases(value: string) {
  return value.replace(/\s/g, '').length;
}

function firstRefName(fasta: string) {
  return /^>(\S+)/m.exec(fasta)?.[1] || '';
}

function formatBytes(value: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function statusLabel(status: JobState['status']) {
  if (status === 'succeeded') return 'Ready';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatExpiry(value?: string | null) {
  if (!value) return null;
  const expiry = new Date(value);
  return Number.isNaN(expiry.getTime()) ? null : expiry.toLocaleString();
}

export default function PredictionWorkbench({ siteKey, modelVersion, maxGenomeBytes = predictionMaxRequestBytes(), localTest = false }: { siteKey: string; modelVersion: string; maxGenomeBytes?: number; localTest?: boolean }) {
  const [mode, setMode] = useState<'genome_scan' | 'predict'>('genome_scan');
  const [fasta, setFasta] = useState('');
  const [fileName, setFileName] = useState('');
  const [sequence, setSequence] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [jobToken, setJobToken] = useState('');
  const [job, setJob] = useState<JobState | null>(null);
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [refName, setRefName] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [openingJob, setOpeningJob] = useState('');
  const [history, setHistory] = useState<PredictionHistoryEntry[]>([]);
  const [showNew, setShowNew] = useState(true);
  const widget = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const jobView = useRef<HTMLElement>(null);

  const persistHistory = useCallback((entry: PredictionHistoryEntry) => {
    setHistory((current) => {
      const next = upsertPredictionHistory(current, entry);
      localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateHistoryStatus = useCallback((jobId: string, status: JobState['status']) => {
    setHistory((current) => {
      const existing = current.find((entry) => entry.jobId === jobId);
      if (!existing || existing.status === status) return current;
      const next = upsertPredictionHistory(current, { ...existing, status });
      localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!siteKey || !showNew) return;
    const render = () => {
      if (!widget.current || !window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(widget.current, {
        sitekey: siteKey,
        callback: setTurnstileToken,
        'expired-callback': () => setTurnstileToken(''),
      });
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-rapptor-turnstile]');
    const script = existing || document.createElement('script');
    if (!existing) {
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.rapptorTurnstile = 'true';
      document.head.appendChild(script);
    }
    script.addEventListener('load', render);
    render();
    return () => {
      script.removeEventListener('load', render);
      if (widgetId.current) window.turnstile?.remove?.(widgetId.current);
      widgetId.current = undefined;
    };
  }, [showNew, siteKey]);

  useEffect(() => {
    const storedHistory = parsePredictionHistory(localStorage.getItem(PREDICTION_HISTORY_KEY));
    setHistory(storedHistory);
    try {
      const saved = JSON.parse(sessionStorage.getItem('rapptor-prediction-job') || 'null') as Partial<PredictionHistoryEntry> | null;
      if (!saved?.jobId || !saved.token) return;
      setJobToken(saved.token);
      setRefName(saved.refName || '');
      void fetch(`/api/predictions/jobs/${saved.jobId}`, { headers: { 'X-Job-Token': saved.token }, cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error();
          const restored = await response.json() as JobState;
          if (restored.status === 'succeeded') {
            await fetch(`/api/predictions/jobs/${restored.job_id}/session`, { method: 'POST', headers: { 'X-Job-Token': saved.token! } });
          }
          setJob(restored);
          setShowNew(false);
          const existing = storedHistory.find((entry) => entry.jobId === saved.jobId);
          persistHistory({
            jobId: saved.jobId!,
            token: saved.token!,
            refName: saved.refName || '',
            status: restored.status,
            mode: saved.mode || existing?.mode || 'genome_scan',
            submittedAt: saved.submittedAt || existing?.submittedAt || restored.submitted_at || new Date().toISOString(),
            label: saved.label || existing?.label || saved.refName || `Job ${saved.jobId!.slice(0, 8)}`,
            bases: saved.bases || existing?.bases || 0,
          });
        })
        .catch(() => setMessage('The saved task is temporarily unavailable.'));
    } catch { sessionStorage.removeItem('rapptor-prediction-job'); }
  }, [persistHistory]);

  useEffect(() => {
    if (!job || !jobToken || ['succeeded', 'failed'].includes(job.status)) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        const response = await fetch(`/api/predictions/jobs/${job.job_id}`, { headers: { 'X-Job-Token': jobToken }, cache: 'no-store' });
        if (!response.ok) throw new Error('Task status is unavailable.');
        const next = await response.json() as JobState;
        if (next.status === 'succeeded') {
          await fetch(`/api/predictions/jobs/${next.job_id}/session`, { method: 'POST', headers: { 'X-Job-Token': jobToken } });
        }
        setJob(next);
        updateHistoryStatus(next.job_id, next.status);
      } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Task status is unavailable.'); }
      finally { if (!cancelled) timer = window.setTimeout(poll, 3000); }
    };
    timer = window.setTimeout(poll, 3000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [job, jobToken, updateHistoryStatus]);

  useEffect(() => {
    setSummary(null);
    if (job?.status !== 'succeeded' || !job.result?.artifacts?.some((artifact) => artifact.filename === 'summary.json')) return;
    const controller = new AbortController();
    void fetch(`/api/predictions/jobs/${job.job_id}/artifacts/summary.json`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        setSummary(await response.json() as JobSummary);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [job?.job_id, job?.result?.artifacts, job?.status]);

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > maxGenomeBytes) { setMessage(`FASTA exceeds the ${formatPredictionMaxRequestBytes(maxGenomeBytes)} request limit.`); return; }
    setFasta(await file.text());
    setFileName(file.name);
    setRefName('');
  }

  async function openHistory(entry: PredictionHistoryEntry) {
    setMessage('');
    if (job?.job_id === entry.jobId) {
      setShowNew(false);
      window.requestAnimationFrame(() => {
        jobView.current?.focus({ preventScroll: true });
        jobView.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return;
    }
    setOpeningJob(entry.jobId);
    try {
      const response = await fetch(`/api/predictions/jobs/${entry.jobId}`, { headers: { 'X-Job-Token': entry.token }, cache: 'no-store' });
      if (!response.ok) throw new Error('This saved task is no longer available on the prediction service.');
      const restored = await response.json() as JobState;
      if (restored.status === 'succeeded') {
        await fetch(`/api/predictions/jobs/${entry.jobId}/session`, { method: 'POST', headers: { 'X-Job-Token': entry.token } });
      }
      setJob(restored);
      setShowNew(false);
      setJobToken(entry.token);
      setRefName(entry.refName);
      const nextEntry = { ...entry, status: restored.status };
      persistHistory(nextEntry);
      sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(nextEntry));
      window.requestAnimationFrame(() => {
        jobView.current?.focus({ preventScroll: true });
        jobView.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The saved task is unavailable.');
    } finally {
      setOpeningJob('');
    }
  }

  function removeHistory(jobId: string) {
    if (job?.job_id === jobId && (job.status === 'queued' || job.status === 'running')) return;
    if (job?.job_id === jobId) {
      sessionStorage.removeItem('rapptor-prediction-job');
      setShowNew(true);
    }
    setHistory((current) => {
      const next = current.filter((entry) => entry.jobId !== jobId);
      localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }

  function clearHistory() {
    if (job?.status === 'queued' || job?.status === 'running') return;
    localStorage.removeItem(PREDICTION_HISTORY_KEY);
    sessionStorage.removeItem('rapptor-prediction-job');
    setHistory([]);
    setShowNew(true);
  }

  async function submit() {
    setMessage('');
    const bases = mode === 'genome_scan' ? fastaBases(fasta) : fastaBases(fasta) + sequenceBases(sequence);
    if (!confirmed) { setMessage('Confirm that the FASTA contains the complete genome.'); return; }
    if (!fasta || bases <= 0) { setMessage('Provide a complete-genome FASTA.'); return; }
    if (mode === 'predict' && sequenceBases(sequence) < 100) { setMessage('Target sequence must contain at least 100 bases.'); return; }
    if (!turnstileToken && !localTest) { setMessage('Complete the human verification.'); return; }
    setSubmitting(true);
    try {
      const ticketResponse = await fetch('/api/prediction-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnstileToken: localTest ? 'local-test' : turnstileToken, modelVersion, bases }),
      });
      const ticketBody = await ticketResponse.json() as TicketResponse;
      if (!ticketResponse.ok) throw new Error(ticketBody.error?.message || 'Prediction ticket was rejected.');
      if (!ticketBody.ticket) throw new Error('Prediction ticket response is invalid.');
      const request = mode === 'genome_scan'
        ? { mode, complete_genome: true, fasta, stride: 1, output_formats: ['bigwig', 'gff3'] }
        : { mode, complete_genome: true, sequence, genome_context: fastaSequence(fasta) };
      const response = await fetch('/api/predictions/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Ticket ${ticketBody.ticket}` },
        body: JSON.stringify(request),
      });
      const created = await response.json() as CreatedJobResponse;
      if (!response.ok) throw new Error(created.error?.message || 'Prediction could not be queued.');
      if (!created.job_id || !created.access_token) throw new Error('Prediction job response is invalid.');
      setJob({
        job_id: created.job_id,
        status: 'queued',
        progress: { stage: 'queued', percent: 0 },
        artifacts_expires_at: created.artifacts_expires_at,
      });
      setShowNew(false);
      setJobToken(created.access_token);
      const firstReference = firstRefName(fasta);
      setRefName(firstReference);
      const entry: PredictionHistoryEntry = {
        jobId: created.job_id,
        token: created.access_token,
        refName: firstReference,
        status: 'queued',
        mode,
        submittedAt: new Date().toISOString(),
        label: fileName || firstReference || `Job ${created.job_id.slice(0, 8)}`,
        bases,
      };
      persistHistory(entry);
      sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(entry));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Prediction could not be queued.');
    } finally {
      setSubmitting(false);
      setTurnstileToken('');
      (window.turnstile as TurnstileWidget | undefined)?.reset?.(widgetId.current);
    }
  }

  const artifacts = job?.result?.artifacts || [];
  const gffArtifacts = artifacts.filter((artifact) => artifact.format === 'gff3');
  const hasBrowserFiles = ['scores.plus.bw', 'scores.minus.bw', 'input.fasta', 'input.fasta.fai']
    .every((name) => artifacts.some((artifact) => artifact.filename === name));
  const serviceAvailable = Boolean(siteKey) || localTest;
  const serviceTone = serviceAvailable ? styles.statusReady : styles.statusUnavailable;
  const serviceLabel = serviceAvailable ? 'SERVICE READY' : 'SERVICE UNAVAILABLE';
  const serviceTitle = serviceAvailable ? 'Prediction service ready' : 'Prediction unavailable';
  const serviceBody = serviceAvailable
    ? 'Validated input goes to the configured RAPPTOR service.'
    : 'Turnstile and prediction service settings are not configured.';
  const activeJob = job?.status === 'queued' || job?.status === 'running';
  const selectedEntry = history.find((entry) => entry.jobId === job?.job_id);
  const artifactsExpireAt = formatExpiry(job?.artifacts_expires_at);
  const jobProgress: PredictionProgressSnapshot | null = job ? normalizePredictionProgress({
    state: job.status === 'unknown' ? 'running' : job.status,
    stage: job.progress?.stage || job.status,
    percent: job.progress?.percent ?? null,
    message: job.error
      ? job.error.message || job.error.type || 'Prediction failed.'
      : job.status === 'queued'
        ? 'Waiting for an available worker.'
        : job.status === 'succeeded'
          ? 'Result ready.'
          : `Current stage: ${(job.progress?.stage || 'running').replaceAll('_', ' ')}.`,
    contig: job.progress?.contig,
    strand: job.progress?.strand === '+' || job.progress?.strand === '-' ? job.progress.strand : undefined,
    windows: job.progress?.windows,
  }) : null;

  return (
    <div className={styles.section}>
      <div className="portal-shell">
        <div className={`${styles.serviceBar} ${serviceTone}`} role="status">
          <span className={styles.serviceBadge}>{serviceLabel}</span>
          <div><strong>{serviceTitle}</strong><span>{serviceBody}</span></div>
        </div>

        <div className={styles.workspace}>
          <div className={styles.workspaceMain}>
            {showNew ? <div className={styles.workbench}>
              <div className={styles.workbenchHeader}>
                <div><span>INPUT WORKBENCH</span><strong>Prediction input and genome context</strong></div>
                <p><strong>100 bp</strong> windows · base 80 anchor</p>
              </div>

              <div className={styles.inputGrid}>
                <fieldset className={styles.card}>
                  <legend><span>1</span><div>Prediction input<small>{PORTAL_TERMS.sequenceScan} or target sequence</small></div></legend>
                  <div className={styles.tabs} role="group" aria-label="Prediction mode">
                    <button type="button" className={mode === 'genome_scan' ? styles.activeTab : ''} aria-pressed={mode === 'genome_scan'} onClick={() => setMode('genome_scan')}>{PORTAL_TERMS.sequenceScan}</button>
                    <button type="button" className={mode === 'predict' ? styles.activeTab : ''} aria-pressed={mode === 'predict'} onClick={() => setMode('predict')}>Target sequence</button>
                  </div>
                  {mode === 'predict' ? <>
                    <label className="sr-only" htmlFor="prediction-target-sequence">Target sequence</label>
                    <textarea id="prediction-target-sequence" value={sequence} onChange={(event) => setSequence(event.target.value)} rows={7} spellCheck={false} placeholder="ACGT…" />
                    <div className={styles.inputStatus}><span>Minimum 100 bases · ACGTN accepted · U becomes T</span></div>
                  </> : <div className={styles.contextWarning}><strong>{PORTAL_TERMS.sequenceScan}</strong><span>Every 100 bp window is scored at stride 1; no cutoff or top-k is applied.</span></div>}
                  <label className={styles.checkbox}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>Complete genome confirmed</strong><small>Used to calculate the 128×128 CGR context.</small></span></label>
                </fieldset>

                <fieldset className={styles.card}>
                  <legend><span>2</span><div>{PORTAL_TERMS.genomeContextCgr}<small>Required for both prediction modes</small></div></legend>
                  <div className={styles.uploadZone}>
                    <button type="button" onClick={() => document.getElementById('prediction-genome-file')?.click()}><span><strong>{fasta ? 'Complete-genome FASTA selected' : 'Choose complete-genome FASTA'}</strong><small>{fasta ? `${fastaBases(fasta).toLocaleString()} bases · ${firstRefName(fasta) || 'No header'}` : 'FASTA, FASTA.gz, or plain text'}</small></span></button>
                    <input id="prediction-genome-file" className="sr-only" type="file" accept=".fa,.fasta,.fna,.txt,text/plain" onChange={(event) => void readFile(event.target.files?.[0])} />
                    {fasta ? <button className={styles.removeFile} type="button" onClick={() => { setFasta(''); setFileName(''); setRefName(''); }}>Remove file</button> : <p>The genome is sent only to the configured prediction service.</p>}
                  </div>
                  {mode === 'genome_scan' && <div className={styles.outputPlan}><strong>Result</strong><span>One GFF3 download. BigWig powers the genome view and is not listed for download.</span></div>}
                </fieldset>
              </div>

              <div className={styles.submitRow}>
                <div ref={widget} className={styles.turnstile} />
                <div className={styles.submitCopy}><strong>Queued prediction</strong><span>Results remain private and are available through token-protected artifact links.</span></div>
                <button type="button" className={`portal-button portal-button-primary ${styles.submitButton}`} disabled={submitting || !serviceAvailable || activeJob} onClick={() => void submit()}>{submitting ? 'Submitting…' : activeJob ? 'Prediction running' : 'Queue prediction'}</button>
              </div>
              {!serviceAvailable && <div className={styles.formError} role="alert"><span>Prediction verification is not configured for this deployment.</span></div>}
              {message && <div className={styles.formError} role="alert"><span>{message}</span></div>}
              <p className={styles.disclaimer}>RAPPTOR outputs are model predictions, not experimental validation. Sequence scans use stride 1 without cutoff or top-k.</p>
            </div> : job ? <section ref={jobView} className={styles.jobDetail} tabIndex={-1} aria-live="polite">
              <div className={styles.jobDetailHeader}>
                <div><span>SELECTED PREDICTION</span><strong>{selectedEntry?.label || refName || `Job ${job.job_id.slice(0, 8)}`}</strong></div>
                <i data-status={job.status}>{statusLabel(job.status)}</i>
              </div>
              {message && <div className={styles.formError} role="alert"><span>{message}</span></div>}
              {jobProgress ? <PredictionProgressPanel mode={(selectedEntry?.mode || mode) === 'genome_scan' ? 'scan' : 'focused'} snapshot={jobProgress} /> : null}

              {summary && <section className={styles.jobSection}>
                <div className={styles.panelHeading}><div><p className="portal-kicker">Prediction summary</p><h2>Run statistics</h2></div></div>
                <div className={styles.resultSummary}>
                  {summary.mode === 'predict' ? <>
                    <div><span>Target bases</span><strong>{summary.sequence_bases?.toLocaleString() ?? '—'}</strong><small>Submitted target sequence</small></div>
                    <div><span>Context bases</span><strong>{summary.genome_context_bases?.toLocaleString() ?? '—'}</strong><small>Genome context used for CGR</small></div>
                    <div><span>Windows scored</span><strong>{summary.window_count?.toLocaleString() ?? '—'}</strong><small>Stride 1 model windows</small></div>
                    <div><span>Highest model score</span><strong>{summary.max_score?.toFixed(4) ?? '—'}</strong><small>Highest score in the result</small></div>
                  </> : <>
                    <div><span>Genome bases</span><strong>{summary.total_bases?.toLocaleString() ?? '—'}</strong><small>Uploaded assembly length</small></div>
                    <div><span>Windows scored</span><strong>{summary.window_count?.toLocaleString() ?? '—'}</strong><small>Plus and minus strands combined</small></div>
                    <div><span>{PORTAL_TERMS.stride}</span><strong>{summary.stride?.toLocaleString() ?? '—'}</strong><small>Bases between adjacent windows</small></div>
                    <div><span>Contigs</span><strong>{summary.contig_count?.toLocaleString() ?? '—'}</strong><small>FASTA records scanned</small></div>
                  </>}
                </div>
              </section>}

              {artifacts.length > 0 && <section className={styles.jobSection}>
                <div className={styles.panelHeading}><div><p className="portal-kicker">Download</p><h2>GFF3 result</h2></div><p>{artifactsExpireAt ? <>Available until <time dateTime={job.artifacts_expires_at!}>{artifactsExpireAt}</time></> : 'Earlier task · no expiry assigned'}</p></div>
                {gffArtifacts.length > 0
                  ? <div className={styles.downloads}>{gffArtifacts.map((artifact) => <a key={artifact.filename} href={`/api/predictions/jobs/${job.job_id}/artifacts/${artifact.filename}`} download><span><strong>{artifact.filename}</strong><small>GFF3 · {formatBytes(artifact.size_bytes)}</small></span><code>{artifact.sha256.slice(0, 12)}…</code></a>)}</div>
                  : <p className={styles.artifactNotice}>This task did not request GFF3. Run it again for GFF3; its BigWig tracks remain in the genome browser.</p>}
              </section>}

              {job.status === 'succeeded' && hasBrowserFiles && refName && <section className={styles.jobSection}>
                <div className={styles.panelHeading}><div><p className="portal-kicker">Genome and prediction tracks</p><h2>Genome browser</h2></div></div>
                <div className={styles.predictionBrowser}><PredictionBrowser jobId={job.job_id} refName={refName} /></div>
              </section>}
            </section> : <section className={styles.emptyWorkspace}><h2>Select a prediction</h2><p>Choose New prediction or open a recent run from the list.</p></section>}
          </div>

          <aside className={styles.recentPanel} aria-label="Recent predictions">
            <div className={styles.recentHeading}><div><p className="portal-kicker">Stored in this browser</p><h2>Recent predictions</h2></div><button type="button" className={styles.clearHistory} disabled={!history.length || activeJob} title={activeJob ? 'The running task is kept so its result remains accessible.' : undefined} onClick={clearHistory}>Clear</button></div>
            <p className={styles.historyNote}>Only access details are saved locally; sequence content is not stored.</p>
            <div className={styles.historyList}>
              <button type="button" className={`${styles.newPrediction} ${showNew ? styles.activeRecent : ''}`} aria-current={showNew ? 'page' : undefined} onClick={() => { setShowNew(true); setMessage(''); }}><strong>＋ New prediction</strong><small>Start a sequence scan or target-sequence test</small></button>
              {history.map((entry) => <div key={entry.jobId} className={!showNew && job?.job_id === entry.jobId ? styles.activeRecent : ''}>
                <button type="button" className={styles.historyOpen} aria-current={!showNew && job?.job_id === entry.jobId ? 'page' : undefined} disabled={openingJob === entry.jobId} onClick={() => void openHistory(entry)}>
                  <span><strong>{entry.label}</strong><small>{entry.mode === 'genome_scan' ? PORTAL_TERMS.sequenceScan : 'Target sequence'} · {entry.bases > 0 ? `${entry.bases.toLocaleString()} bases` : 'Bases unavailable'}<br />{new Date(entry.submittedAt).toLocaleString()}</small></span>
                  <div className={styles.historyAction}><i data-status={entry.status}>{statusLabel(entry.status)}</i><b>{openingJob === entry.jobId ? 'Opening…' : !showNew && job?.job_id === entry.jobId ? 'Selected' : activeJob && job?.job_id === entry.jobId ? 'View progress' : 'View'}</b></div>
                </button>
                <button type="button" className={styles.historyRemove} disabled={activeJob && job?.job_id === entry.jobId} aria-label={`Remove ${entry.label} from browser history`} onClick={() => removeHistory(entry.jobId)}>Remove</button>
              </div>)}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
