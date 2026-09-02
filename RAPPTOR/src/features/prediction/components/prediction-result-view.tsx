'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded';
import UnifiedBrowserPanel from '@/features/genome-browser/components/unified-browser-panel';
import type { JBrowseAssemblyConfig } from '@/features/genome-browser/types';
import PredictionProgressPanel from './prediction-progress-panel';
import { predictionApi, PredictionClientError } from '../client';
import { normalizePredictionProgress } from '../progress';
import {
  PREDICTION_ANCHOR_BASE,
  PREDICTION_DOWNSTREAM_BASES,
  predictionAnchorCoordinate,
  type PredictionBrowserAssets,
  type PredictionJob,
  type PredictionResult,
} from '../types';
import styles from './prediction.module.css';

function formatScore(value: number) {
  return value.toFixed(3);
}

export function resultTsv(result: PredictionResult) {
  const header = ['rank', 'probability', 'classification', 'strand', 'prediction_anchor_1based', 'promoter_start_1based', 'promoter_end_1based'];
  return [header.join('\t'), ...result.topWindows.map((window) => [
    window.rank,
    window.probability.toFixed(6),
    window.probability > result.probabilityThreshold ? 'model-positive-candidate' : 'below-model-threshold',
    window.strand,
    predictionAnchorCoordinate(window.promoterStart, window.strand),
    window.promoterStart,
    window.promoterEnd,
  ].join('\t'))].join('\n') + '\n';
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function nonEmpty(value: string) {
  return Boolean(value.trim());
}

function validAssetUrl(value: string) {
  const candidate = value.trim();
  if (!candidate || candidate.startsWith('//')) return false;
  const scheme = candidate.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  return !scheme || scheme === 'https' || scheme === 'http';
}

export function predictionBrowserAssembly(assets: PredictionBrowserAssets | undefined, demo: boolean, now = Date.now()): JBrowseAssemblyConfig | null {
  if (!assets || demo || !nonEmpty(assets.assemblyName) || !nonEmpty(assets.defaultLocus)) return null;
  const expiresAt = Date.parse(assets.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  const required = [
    assets.reference.fastaUrl,
    assets.reference.faiUrl,
    assets.reference.gziUrl,
    assets.scores.plusBigWigUrl,
    assets.promoters.gff3Url,
    assets.promoters.indexUrl,
  ];
  if (!required.every(validAssetUrl) || (assets.scores.minusBigWigUrl !== null && !validAssetUrl(assets.scores.minusBigWigUrl))) return null;
  return {
    assemblyName: assets.assemblyName,
    defaultLocus: assets.defaultLocus,
    assetBase: '',
    adapterMode: 'indexed',
    assets: {
      fasta: assets.reference.fastaUrl,
      fastaFai: assets.reference.faiUrl,
      fastaGzi: assets.reference.gziUrl,
      predictedPromoters: assets.promoters.gff3Url,
      predictedPromotersIndex: assets.promoters.indexUrl,
      promoterScoresPlus: assets.scores.plusBigWigUrl,
      promoterScoresMinus: assets.scores.minusBigWigUrl,
      ncbiAnnotations: null,
      ncbiAnnotationsIndex: null,
    },
    trackLabels: {
      scores: assets.scores.minusBigWigUrl
        ? 'RAPPTOR promoter probabilities (+ / − strands)'
        : 'RAPPTOR promoter probabilities (+ strand)',
      promoters: 'RAPPTOR model-positive promoter windows',
    },
  };
}

function ScoreChart({ result }: { result: PredictionResult }) {
  const width = 820;
  const height = 268;
  const padLeft = 52;
  const padRight = 24;
  const padTop = 24;
  const padBottom = 42;
  const anchors = result.scoreSeries.flatMap((point) => [
    predictionAnchorCoordinate(point.windowStart, '+'),
    ...(point.minus === null ? [] : [predictionAnchorCoordinate(point.windowStart, '-')]),
  ]);
  const min = Math.min(...anchors);
  const max = Math.max(...anchors);
  const x = (position: number) => padLeft + ((position - min) / Math.max(1, max - min)) * (width - padLeft - padRight);
  const y = (score: number) => height - padBottom - score * (height - padTop - padBottom);
  const path = (key: 'plus' | 'minus') => result.scoreSeries
    .filter((point) => point[key] !== null)
    .map((point, index) => `${index ? 'L' : 'M'} ${x(predictionAnchorCoordinate(point.windowStart, key === 'plus' ? '+' : '-')).toFixed(1)} ${y(Number(point[key])).toFixed(1)}`)
    .join(' ');
  const bestAnchor = predictionAnchorCoordinate(result.bestWindow.promoterStart, result.bestWindow.strand);
  const bestAnchorX = x(bestAnchor);
  const bandWidth = Math.min(28, Math.max(10, (width - padLeft - padRight) / Math.max(1, result.scoreSeries.length) * .55));
  const bandX = Math.max(padLeft, Math.min(width - padRight - bandWidth, bestAnchorX - bandWidth / 2));
  const xTicks = Array.from(new Set([min, bestAnchor, max]));
  const windowLeft = ((result.bestWindow.promoterStart - 1) / result.input.length) * 100;
  const upstreamWidth = (PREDICTION_ANCHOR_BASE / result.input.length) * 100;
  const downstreamWidth = (PREDICTION_DOWNSTREAM_BASES / result.input.length) * 100;
  const upstreamLeft = result.bestWindow.strand === '+' ? windowLeft : windowLeft + downstreamWidth;
  const downstreamLeft = result.bestWindow.strand === '+' ? windowLeft + upstreamWidth : windowLeft;
  const anchorLeft = ((bestAnchor - .5) / result.input.length) * 100;

  return (
    <figure className={styles.scoreChart}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Promoter probability across candidate positions" data-testid="prediction-score-chart">
        {[0, .25, .5, .75, 1].map((score) => <g key={score}><line x1={padLeft} x2={width - padRight} y1={y(score)} y2={y(score)} /><text x={8} y={y(score) + 4}>{score.toFixed(2)}</text></g>)}
        <text className={styles.yAxisLabel} x={15} y={height / 2} textAnchor="middle" transform={`rotate(-90 15 ${height / 2})`}>Probability</text>
        {xTicks.map((tick) => <text key={tick} x={x(tick)} y={height - 23} textAnchor={tick === min ? 'start' : tick === max ? 'end' : 'middle'}>{tick}</text>)}
        <text x={width / 2} y={height - 8} textAnchor="middle">Prediction anchor coordinate (1-based)</text>
        <rect
          className={styles.bestWindowBand}
          data-testid="prediction-best-window"
          x={bandX}
          width={bandWidth}
          y={padTop}
          height={height - padTop - padBottom}
        />
        <line className={styles.thresholdLine} x1={padLeft} x2={width - padRight} y1={y(result.probabilityThreshold)} y2={y(result.probabilityThreshold)} />
        <path className={styles.chartPlus} data-testid="prediction-score-plus" d={path('plus')} />
        {result.input.strandMode === 'both' ? <path className={styles.chartMinus} d={path('minus')} /> : null}
        {result.scoreSeries.map((point) => <g key={point.windowStart}>
          <circle className={styles.chartPointPlus} cx={x(predictionAnchorCoordinate(point.windowStart, '+'))} cy={y(point.plus)} r="2.5" />
          {point.minus !== null ? <circle className={styles.chartPointMinus} cx={x(predictionAnchorCoordinate(point.windowStart, '-'))} cy={y(point.minus)} r="2.5" /> : null}
        </g>)}
        <circle className={styles.peakPoint} cx={bestAnchorX} cy={y(result.highestProbability)} r="5" />
        <text className={styles.peakLabel} x={Math.min(width - 176, bestAnchorX + 9)} y={Math.max(16, y(result.highestProbability) - 9)}>Anchor {bestAnchor} · {result.bestWindow.promoterStart}–{result.bestWindow.promoterEnd} ({result.bestWindow.strand}) · {formatScore(result.highestProbability)}</text>
      </svg>
      <figcaption>
        <span><i className={styles.legendPlus} /> Forward strand</span>
        {result.input.strandMode === 'both' ? <span><i className={styles.legendMinus} /> Reverse strand</span> : null}
        <span><i className={styles.legendBestWindow} /> Highest-scoring prediction anchor</span>
        <span><i className={styles.legendThreshold} /> {result.probabilityThreshold.toFixed(1)} model threshold</span>
      </figcaption>
      <div className={styles.windowMap} data-testid="prediction-window-map">
        <div><span>Best window layout</span><strong>{result.bestWindow.promoterStart.toLocaleString()}–{result.bestWindow.promoterEnd.toLocaleString()} · anchor {bestAnchor.toLocaleString()} · {result.bestWindow.strand} strand</strong></div>
        <div className={styles.windowMapTrack} data-strand={result.bestWindow.strand} aria-label={`Best promoter window spans bases ${result.bestWindow.promoterStart} through ${result.bestWindow.promoterEnd}; prediction anchor is base ${bestAnchor}`}>
          <i className={styles.windowUpstream} style={{ left: `${upstreamLeft}%`, width: `${upstreamWidth}%` }} />
          <i className={styles.windowDownstream} style={{ left: `${downstreamLeft}%`, width: `${downstreamWidth}%` }} />
          <b className={styles.anchorMarker} style={{ left: `${anchorLeft}%` }} />
        </div>
        <div className={styles.windowMapScale}><span>1</span><span>{result.input.length.toLocaleString()}</span></div>
        <div className={styles.windowLayoutLegend}><span><i className={styles.legendPlus} /> 80 bp upstream side</span><span><i className={styles.legendMinus} /> 20 bp downstream side</span><strong>Base 80 = prediction anchor</strong></div>
      </div>
    </figure>
  );
}

export default function PredictionResultView({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<PredictionJob | null>(null);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [resultView, setResultView] = useState<'plot' | 'browser'>('plot');

  useEffect(() => {
    let cancelled = false;
    let timeout: number | null = null;
    setError(null);

    const poll = async () => {
      try {
        const nextJob = await predictionApi<PredictionJob>(`/api/predictions/${encodeURIComponent(jobId)}`);
        if (cancelled) return;
        setJob(nextJob);
        if (nextJob.state === 'succeeded') {
          const nextResult = await predictionApi<PredictionResult>(`/api/predictions/${encodeURIComponent(jobId)}/result`);
          if (!cancelled) setResult(nextResult);
          return;
        }
        if (nextJob.state === 'failed') {
          setError({ message: nextJob.error?.message || 'Prediction failed.', retryable: Boolean(nextJob.error?.retryable) });
          return;
        }
        timeout = window.setTimeout(poll, 650);
      } catch (cause) {
        if (!cancelled) setError({ message: cause instanceof PredictionClientError ? cause.message : 'Prediction status could not be loaded.', retryable: cause instanceof PredictionClientError ? cause.retryable : true });
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [jobId, retryKey]);

  const demo = Boolean(job?.demo || result?.demo || jobId.startsWith('demo_'));
  const browserAssembly = useMemo(() => predictionBrowserAssembly(result?.browserAssets, demo), [demo, result?.browserAssets]);
  const jobProgress = useMemo(() => normalizePredictionProgress({
    state: job?.state || 'queued',
    stage: job?.state === 'succeeded' ? 'complete' : job?.state === 'failed' ? 'failed' : job?.state || 'queued',
    percent: job?.progress ?? null,
    message: job?.message || 'Loading prediction job status…',
    simulated: demo,
  }), [demo, job]);

  useEffect(() => {
    if (!browserAssembly) setResultView('plot');
  }, [browserAssembly]);

  if (error) {
    if (job?.state === 'failed') {
      return (
        <main className={`portal-page ${styles.resultPage}`}>
          <div className="portal-shell">
            <header className={`page-intro ${styles.resultIntro}`}><div><p className="portal-kicker">Prediction job</p><h1>Prediction could not be completed</h1></div></header>
            <PredictionProgressPanel mode="focused" snapshot={{ ...jobProgress, state: 'failed', stage: 'failed', message: error.message }} onRetry={error.retryable ? () => setRetryKey((value) => value + 1) : undefined} />
          </div>
        </main>
      );
    }
    return (
      <main className={`portal-page ${styles.resultPage}`}>
        <div className="portal-shell portal-state-page">
          <div className="portal-state-icon"><ErrorOutlineRoundedIcon /></div>
          <p className="portal-kicker">Prediction unavailable</p>
          <h1>Result could not be loaded</h1>
          <p>{error.message}</p>
          <div className={styles.stateActions}>
            {error.retryable ? <button className="portal-button portal-button-primary" type="button" onClick={() => setRetryKey((value) => value + 1)}>Retry</button> : null}
            <Link className={styles.secondaryAction} href="/predict">Return to prediction form</Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={`portal-page ${styles.resultPage}`}>
      <div className="portal-shell">
        <header className={`page-intro ${styles.resultIntro}`}>
          <div className={styles.resultIntroCopy}>
            <p className="portal-kicker">Candidate promoter scoring</p>
            <h1>{demo ? 'Demo result preview' : 'Prediction result'}</h1>
            <p>Each 100 bp window uses base 80 as the prediction anchor: an 80 bp upstream-side segment followed by a 20 bp downstream-side segment.</p>
          </div>
          <div className={styles.jobMeta}><span>JOB IDENTIFIER</span><code>{jobId}</code><span>{job?.modelVersion || 'Loading model metadata…'}</span></div>
        </header>

        {demo ? <div className={styles.demoBanner} role="note"><ScienceRoundedIcon aria-hidden="true" /><div><strong>Demo preview — no model was executed</strong><span>Every score on this page is a deterministic interface fixture. It must not be interpreted as biological output.</span></div></div> : null}

        <PredictionProgressPanel mode="focused" snapshot={jobProgress} />

        {result ? <div className={styles.resultContent}>
          <section className={styles.resultSummary} aria-label="Prediction summary" data-testid="prediction-summary">
            <div><span>Highest promoter probability</span><strong>{formatScore(result.highestProbability)}</strong><small>Best hit: {result.bestWindow.strand} strand</small></div>
            <div><span>Model classification</span><strong className={result.call === 'model-positive-candidate' ? styles.positive : ''}>{result.call === 'model-positive-candidate' ? 'RAPPtor model-positive candidate' : 'Below model threshold'}</strong><small>Score cutoff: &gt; {result.probabilityThreshold.toFixed(1)}</small></div>
            <div><span>Evaluated strands</span><strong>{result.input.strandMode === 'both' ? 'Both (+/−)' : 'Forward only'}</strong><small>{result.input.strandMode === 'both' ? 'Forward and reverse-complement' : '+ strand only'}</small></div>
            <div><span>Best promoter window</span><strong>{result.bestWindow.promoterStart.toLocaleString()}–{result.bestWindow.promoterEnd.toLocaleString()}</strong><small>Prediction anchor {predictionAnchorCoordinate(result.bestWindow.promoterStart, result.bestWindow.strand).toLocaleString()} · window base 80</small></div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div><p className="portal-kicker">Window scores</p><h2>Promoter probability by prediction anchor</h2></div>
              {browserAssembly ? <div className={styles.resultViewTools}>
                <div className={styles.viewSwitch} role="group" aria-label="Result visualization">
                  <button type="button" className={resultView === 'plot' ? styles.activeView : ''} aria-pressed={resultView === 'plot'} onClick={() => setResultView('plot')}>Score plot</button>
                  <button type="button" className={resultView === 'browser' ? styles.activeView : ''} aria-pressed={resultView === 'browser'} onClick={() => setResultView('browser')}>Genome browser</button>
                </div>
              </div> : null}
            </div>
            {result.browserAssets && !browserAssembly && !demo ? <p className={styles.browserUnavailable} role="status">Genome browser assets are incomplete or expired. The score plot remains available.</p> : null}
            {resultView === 'browser' && browserAssembly
              ? <div className={styles.predictionBrowser}><UnifiedBrowserPanel prediction={browserAssembly} /></div>
              : <ScoreChart result={result} />}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeading}><div><p className="portal-kicker">Ranked windows</p><h2>Top promoter windows</h2></div><div className={styles.downloads}><button type="button" onClick={() => download(`${jobId}.json`, JSON.stringify(result, null, 2) + '\n', 'application/json')}><DownloadRoundedIcon /> JSON</button><button type="button" onClick={() => download(`${jobId}.tsv`, resultTsv(result), 'text/tab-separated-values')}><DownloadRoundedIcon /> TSV</button></div></div>
            <div className={styles.tableWrap}><table className={styles.windowTable}><thead><tr><th>Rank</th><th>Probability</th><th>Classification</th><th>Strand</th><th>Prediction anchor</th><th>Promoter window (1-based)</th></tr></thead><tbody>{result.topWindows.map((window) => <tr key={`${window.strand}-${window.promoterStart}`}><td>{window.rank}</td><td>{formatScore(window.probability)}</td><td>{window.probability > result.probabilityThreshold ? 'Model-positive candidate' : 'Below threshold'}</td><td>{window.strand}</td><td>{predictionAnchorCoordinate(window.promoterStart, window.strand).toLocaleString()}</td><td>{window.promoterStart.toLocaleString()}–{window.promoterEnd.toLocaleString()}</td></tr>)}</tbody></table></div>
          </section>

          <section className={styles.runContext} aria-label="Prediction context">
            <div><span>Model</span><strong>{result.modelVersion}</strong></div>
            <div><span>Genome context</span><strong>{result.genomeContext.label}</strong></div>
          </section>

          <div className={styles.evidence}><div><strong>How to interpret this result</strong><p>RAPPTOR scores rank computational promoter candidates; they do not establish experimental transcription initiation or condition-specific activity. <Link href="/help/prediction#results">Read the interpretation guide.</Link></p></div><Link href="/predict">Start another prediction</Link></div>
        </div> : null}
      </div>
    </main>
  );
}
