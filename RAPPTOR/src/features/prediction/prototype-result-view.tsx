'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded';
import {
  createPrototypeFixture,
  readPrototypePredictionRun,
  type PrototypeCalledPeak,
  type PrototypeCandidateRun,
  type PrototypeGenomeScanRun,
  type PrototypePredictionFixture,
  type PrototypePredictionRun,
  type PrototypeScoreWindow,
  type PrototypeStrand,
} from './prototype';
import {
  downloadPrototypeResult,
  type PrototypeDownloadFormat,
} from './prototype-result-downloads';
import styles from './prototype-result.module.css';

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

function scorePath(
  points: PrototypeScoreWindow[],
  x: (anchor: number) => number,
  y: (score: number) => number,
) {
  return [...points]
    .sort((left, right) => left.anchor - right.anchor)
    .map((point, index) => `${index ? 'L' : 'M'} ${x(point.anchor).toFixed(1)} ${y(point.score).toFixed(1)}`)
    .join(' ');
}

function topPeaks(run: PrototypeGenomeScanRun, fixture: PrototypePredictionFixture) {
  return [...fixture.calledPeaks]
    .sort((left, right) => right.smoothedScore - left.smoothedScore || left.sequenceId.localeCompare(right.sequenceId) || left.anchor - right.anchor)
    .slice(0, run.parameters.topK);
}

function focusedWindows(fixture: PrototypePredictionFixture) {
  return [...fixture.windows].sort((left, right) => left.strand === right.strand ? 0 : left.strand === '+' ? -1 : 1);
}

function submittedAnchor(window: PrototypeScoreWindow) {
  return window.strand === '+' ? `+${window.anchor}` : `−${window.anchor}`;
}

function FocusedSequenceResult({ run, fixture }: { run: PrototypeCandidateRun; fixture: PrototypePredictionFixture }) {
  const windows = focusedWindows(fixture);
  return (
    <>
      <section className={styles.panel} aria-labelledby="focused-score-heading">
        <div className={styles.panelHeader}>
          <h2 id="focused-score-heading">Focused 100 bp raw score{windows.length === 1 ? '' : 's'}</h2>
          <p>Exactly one oriented 100 bp window is scored per evaluated strand. The cutoff labels each score without changing it.</p>
        </div>
        <div className={styles.focusedScoreGrid} data-count={windows.length}>
          {windows.map((window) => {
            const aboveCutoff = window.score > run.parameters.cutoff;
            return (
              <article className={styles.focusedScoreCard} key={window.strand}>
                <div className={styles.focusedScoreHeading}>
                  <span>{window.strand === '+' ? 'Forward strand (+)' : 'Reverse strand (−)'}</span>
                  <strong className={aboveCutoff ? styles.passes : styles.below}>{aboveCutoff ? 'Above cutoff' : 'At or below cutoff'}</strong>
                </div>
                <strong className={styles.focusedScoreValue}>{formatScore(window.score)}</strong>
                <span className={styles.focusedScoreLabel}>Illustrative raw score</span>
                <dl className={styles.focusedScoreFacts}>
                  <div><dt>Submitted-sequence anchor</dt><dd>Base {window.anchor} ({submittedAnchor(window)})</dd></div>
                  <div><dt>Window</dt><dd>{window.windowStart}–{window.windowEnd} · 1-based</dd></div>
                  <div><dt>Cutoff</dt><dd>{run.parameters.cutoff.toFixed(2)} · strict &gt;</dd></div>
                </dl>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="anchor-layout-heading">
        <div className={styles.panelHeader}>
          <h2 id="anchor-layout-heading">Anchor layout on the submitted sequence</h2>
          <p>The same 100 submitted bases are read in transcription orientation. That places the forward anchor at +80 and the reverse anchor at −21.</p>
        </div>
        <figure className={styles.anchorFigure}>
          {windows.map((window) => (
            <div className={styles.anchorRow} key={window.strand}>
              <strong>{window.strand === '+' ? 'Forward (+) →' : '← Reverse (−)'}</strong>
              <div>
                <div className={styles.anchorTrack} data-strand={window.strand} aria-label={`${window.strand === '+' ? 'Forward' : 'Reverse'} strand anchor is submitted-sequence base ${window.anchor}`}>
                  <i className={styles.anchorUpstream} />
                  <i className={styles.anchorDownstream} />
                  <b className={styles.anchorMarker} style={{ left: `${((window.anchor - .5) / 100) * 100}%` }} />
                </div>
                <div className={styles.anchorScale}><span>Base 1</span><span>Base 100</span></div>
              </div>
              <span>Anchor {submittedAnchor(window)}</span>
            </div>
          ))}
          <figcaption><span><i className={styles.anchorUpstreamKey} /> 80 nt upstream side</span><span><i className={styles.anchorDownstreamKey} /> 20 nt downstream side</span><strong>Submitted coordinates: +80 / −21</strong></figcaption>
        </figure>
      </section>
    </>
  );
}

function GenomeContigChart({
  sequenceId,
  points,
  peaks,
  cutoff,
  showReverse,
}: {
  sequenceId: string;
  points: PrototypeScoreWindow[];
  peaks: PrototypeCalledPeak[];
  cutoff: number;
  showReverse: boolean;
}) {
  const width = 900;
  const height = 154;
  const padLeft = 44;
  const padRight = 24;
  const padTop = 18;
  const padBottom = 33;
  const anchors = points.map((point) => point.anchor);
  const minAnchor = Math.min(...anchors);
  const maxAnchor = Math.max(...anchors);
  const x = (anchor: number) => padLeft + ((anchor - minAnchor) / Math.max(1, maxAnchor - minAnchor)) * (width - padLeft - padRight);
  const y = (value: number) => height - padBottom - value * (height - padTop - padBottom);
  const byStrand = (strand: PrototypeStrand) => points.filter((point) => point.strand === strand);

  return (
    <figure className={styles.contigFigure}>
      <h3>{sequenceId}</h3>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Illustrative raw scores and called peaks for ${sequenceId}`}>
        {[0, .5, 1].map((tick) => (
          <g key={tick}>
            <line className={styles.gridLine} x1={padLeft} x2={width - padRight} y1={y(tick)} y2={y(tick)} />
            <text className={styles.axisText} x={5} y={y(tick) + 4}>{tick.toFixed(1)}</text>
          </g>
        ))}
        <line className={styles.cutoffLine} x1={padLeft} x2={width - padRight} y1={y(cutoff)} y2={y(cutoff)} />
        <path className={styles.scorePath} d={scorePath(byStrand('+'), x, y)} />
        {showReverse ? <path className={styles.scorePathAlt} d={scorePath(byStrand('-'), x, y)} /> : null}
        {peaks.map((peak, index) => (
          <g key={`${peak.anchor}:${peak.strand}`}>
            <line className={styles.calledPeakLine} x1={x(peak.anchor)} x2={x(peak.anchor)} y1={y(peak.smoothedScore)} y2={height - padBottom} />
            <circle className={styles.calledPeakPoint} cx={x(peak.anchor)} cy={y(peak.smoothedScore)} r="4.5" />
            {index < 4 ? <text className={styles.calledPeakLabel} x={Math.min(width - 76, x(peak.anchor) + 5)} y={Math.max(10, y(peak.smoothedScore) - 6)}>{peak.anchor}</text> : null}
          </g>
        ))}
        <text className={styles.axisText} x={padLeft} y={height - 9}>{minAnchor}</text>
        <text className={styles.axisText} x={width - padRight} y={height - 9} textAnchor="end">{maxAnchor}</text>
        <text className={styles.axisText} x={width / 2} y={height - 9} textAnchor="middle">Anchor coordinate (1-based)</text>
      </svg>
    </figure>
  );
}

function GenomeScoreCharts({ run, fixture }: { run: PrototypeGenomeScanRun; fixture: PrototypePredictionFixture }) {
  const sequenceIds = Array.from(new Set(fixture.scoreSeries.map((point) => point.sequenceId)));
  return (
    <div className={styles.contigList}>
      {sequenceIds.map((sequenceId) => (
        <GenomeContigChart
          key={sequenceId}
          sequenceId={sequenceId}
          points={fixture.scoreSeries.filter((point) => point.sequenceId === sequenceId)}
          peaks={fixture.calledPeaks.filter((peak) => peak.sequenceId === sequenceId)}
          cutoff={run.parameters.cutoff}
          showReverse={run.parameters.strandMode === 'both'}
        />
      ))}
      <div className={styles.chartLegend} aria-label="Chart legend">
        <span className={styles.legendItem}><i className={styles.legendRaw} /> Forward-strand raw score</span>
        {run.parameters.strandMode === 'both' ? <span className={styles.legendItem}><i className={styles.legendReverse} /> Reverse-strand raw score</span> : null}
        <span className={styles.legendItem}><i className={styles.legendCutoff} /> User-selected cutoff ({run.parameters.cutoff.toFixed(2)})</span>
        <span className={styles.legendItem}><i className={styles.legendPeak} /> Called peak after backend-managed processing</span>
      </div>
    </div>
  );
}

function PeakTable({ run, fixture }: { run: PrototypeGenomeScanRun; fixture: PrototypePredictionFixture }) {
  const rows = topPeaks(run, fixture);
  return (
    <>
      <p className={styles.tableHint}>Top called peaks are ranked by the illustrative smoothed score. Scroll horizontally on a small screen.</p>
      <div className={styles.tableWrap}>
        <table className={styles.resultTable}>
          <caption className="sr-only">Top illustrative called peaks ranked by smoothed score</caption>
          <thead><tr><th>Rank</th><th>Sequence</th><th>Anchor (1-based)</th><th>Window</th><th>Strand</th><th>Raw score</th><th>Smoothed score</th><th>Result type</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((peak, index) => (
              <tr key={`${peak.sequenceId}:${peak.anchor}:${peak.strand}`}>
                <td>{index + 1}</td><td>{peak.sequenceId}</td><td>{peak.anchor.toLocaleString()}</td><td>{peak.windowStart.toLocaleString()}–{peak.windowEnd.toLocaleString()}</td><td>{peak.strand}</td><td>{formatScore(peak.rawScore)}</td><td>{formatScore(peak.smoothedScore)}</td><td><span className={styles.passes}>Called peak</span></td>
              </tr>
            )) : <tr><td className={styles.emptyPeaks} colSpan={8}>No illustrative called peaks are above the selected cutoff. The raw score tracks remain available.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Downloads({ run, fixture }: { run: PrototypePredictionRun; fixture: PrototypePredictionFixture }) {
  const downloads: Array<{ format: PrototypeDownloadFormat; label: string; detail: string }> = run.mode === 'candidate'
    ? [
        { format: 'json', label: 'JSON', detail: 'Focused raw-score result' },
        { format: 'tsv', label: 'TSV', detail: 'One row per evaluated strand' },
        { format: 'bedgraph', label: 'bedGraph', detail: '1 bp anchor scores' },
        { format: 'gff3', label: 'GFF3', detail: 'Focused 100 bp windows' },
        { format: 'bed', label: 'BED6', detail: 'Focused 100 bp windows' },
      ]
    : [
        { format: 'json', label: 'JSON', detail: 'Scan metadata and fixture values' },
        { format: 'tsv', label: 'TSV', detail: 'Called peaks' },
        { format: 'bedgraph', label: 'bedGraph', detail: 'Illustrative raw tracks' },
        { format: 'gff3', label: 'GFF3', detail: 'Called peak features' },
        { format: 'bed', label: 'BED6', detail: '1 bp called peaks' },
      ];
  return (
    <div className={styles.downloads} aria-label="Prototype result downloads">
      {downloads.map((item) => (
        <button className={styles.downloadButton} key={item.format} type="button" onClick={() => downloadPrototypeResult(run, fixture, item.format)}>
          <DownloadRoundedIcon aria-hidden="true" />
          <span>{item.label}<small>{item.detail}</small></span>
        </button>
      ))}
      <button className={styles.disabledDownload} type="button" disabled title="Parquet export will be available with the live prediction service.">
        <DownloadRoundedIcon aria-hidden="true" />
        <span>Parquet<small>Live service only</small></span>
      </button>
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
        </div>
      </div>
    </main>
  );
}

export default function PrototypePredictionResultView({ runId }: { runId: string }) {
  const [run, setRun] = useState<PrototypePredictionRun | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setRun(readPrototypePredictionRun(runId));
    setLoaded(true);
  }, [runId]);

  const fixture = useMemo(() => run ? createPrototypeFixture(run) : null, [run]);

  if (!loaded) {
    return <main className={styles.missing}><div><p className="portal-kicker">Prototype result</p><h1>Loading result…</h1><p>No model was run. Loading the deterministic fixture stored for this tab.</p></div></main>;
  }
  if (!run || !fixture) return <MissingRun />;

  const genomeContext = run.input.genomeContext;
  const sequenceCount = run.mode === 'genome-scan' ? new Set(fixture.scoreSeries.map((point) => point.sequenceId)).size : 0;

  return (
    <main className={styles.page}>
      <div className={`portal-shell ${styles.shell}`}>
        <header className={styles.intro}>
          <div className={styles.introCopy}>
            <p className="portal-kicker">{run.mode === 'candidate' ? 'Focused 100 bp scoring' : 'Whole genome / contigs scan'}</p>
            <h1>Prediction result</h1>
            <p>{run.mode === 'candidate' ? 'Review the single submitted window on each evaluated strand, its raw score, anchor position and cutoff state.' : 'Compare illustrative raw score tracks with the called peaks produced by backend-managed peak calling.'}</p>
          </div>
          <div className={styles.runMeta}><span>Prototype run</span><code>{run.runId}</code><small>{formatCreatedAt(run.createdAt)}</small></div>
        </header>

        <div className={styles.prototypeBanner} role="note">
          <ScienceRoundedIcon aria-hidden="true" />
          <div><strong>No model was run</strong><span>Every value below is a deterministic interface fixture for previewing the workflow. It is not a biological prediction or experimental result.</span></div>
        </div>

        {run.mode === 'candidate' ? <FocusedSequenceResult run={run} fixture={fixture} /> : (
          <>
            <section className={styles.summary} aria-label="Genome scan summary">
              <div><span>Sequences</span><strong>{sequenceCount}</strong><small>Illustrative contigs</small></div>
              <div><span>Raw score windows</span><strong>{fixture.windows.length.toLocaleString()}</strong><small>Deterministic fixture values</small></div>
              <div><span>Called peaks</span><strong>{fixture.calledPeaks.length.toLocaleString()}</strong><small>After backend-managed processing</small></div>
              <div><span>Top results shown</span><strong>{Math.min(run.parameters.topK, fixture.calledPeaks.length)}</strong><small>Display setting only</small></div>
            </section>

            <section className={styles.panel} aria-labelledby="raw-score-heading">
              <div className={styles.panelHeader}>
                <h2 id="raw-score-heading">Raw scores and called peaks</h2>
                <p>A raw score belongs to one 100 nt scan window and its 1-based anchor. A called peak exists only after the genome-scan post-processing step.</p>
              </div>
              <GenomeScoreCharts run={run} fixture={fixture} />
            </section>

            <section className={styles.panel} aria-labelledby="ranked-results-heading">
              <div className={styles.panelHeader}>
                <h2 id="ranked-results-heading">Top called peaks</h2>
                <p>Called peaks are distinct from the underlying raw score windows. Peak calling uses backend-managed settings that are not exposed by this prototype.</p>
              </div>
              <PeakTable run={run} fixture={fixture} />
            </section>
          </>
        )}

        <section className={styles.panel} aria-labelledby="download-heading">
          <div className={styles.panelHeader}>
            <h2 id="download-heading">Download example output</h2>
            <p>{run.mode === 'candidate' ? 'Focused downloads retain each strand raw score and cutoff state without ranking or peak post-processing.' : 'Scan downloads keep raw tracks separate from called peak features.'} Coordinates are 1-based in TSV and GFF3; bedGraph and BED use zero-based, half-open intervals.</p>
          </div>
          <Downloads run={run} fixture={fixture} />
        </section>

        <section className={styles.panel} aria-labelledby="run-context-heading">
          <div className={styles.panelHeader}><h2 id="run-context-heading">Run context</h2><p>Only metadata is restored from session storage. The candidate sequence or uploaded FASTA is not stored here.</p></div>
          <dl className={styles.factGrid}>
            <div><dt>Input</dt><dd>{run.mode === 'candidate' ? `${run.input.displayName} · ${run.input.length.toLocaleString()} nt` : genomeContext.fileName || genomeContext.displayName}</dd></div>
            <div><dt>Genome context</dt><dd>{genomeContext.displayName} · {formatLength(genomeContext.totalLength)}</dd></div>
            <div><dt>Analysis</dt><dd>{run.parameters.strandMode === 'both' ? 'Both strands' : 'Forward strand only'} · cutoff {run.parameters.cutoff.toFixed(2)}</dd></div>
            <div><dt>Read-only model layout</dt><dd>100 nt window · 80/20 anchor · CGR 128×128 · stride 1 · {run.modelSpec.version}</dd></div>
          </dl>
        </section>

        <aside className={styles.interpret} aria-labelledby="interpret-heading">
          <h2 id="interpret-heading">How to interpret this result</h2>
          <p>{run.mode === 'candidate' ? 'Each raw score belongs to the same focused 100 bp input read in one orientation. The cutoff only labels the score state; no ranking or post-processing is applied.' : 'A higher raw score means an illustrative scan window ranks higher within the fixture. A called peak is a post-processed candidate anchor, not a separate model score.'} The result does not establish accuracy, experimental support, or a transcription start site.</p>
        </aside>
      </div>
    </main>
  );
}
