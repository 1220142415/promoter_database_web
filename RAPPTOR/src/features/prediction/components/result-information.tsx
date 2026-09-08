import { exportCutoffLabel, type JobSummary } from '../live-result';
import styles from '../prototype-result.module.css';

function bases(value?: number | null) { return value == null ? 'Not recorded' : `${value.toLocaleString()} bp`; }

export default function ResultInformation({ summary, inputName, refName }: {
  summary: JobSummary; inputName: string; refName: string;
}) {
  const short = summary.mode === 'predict';
  const focused = short && summary.sequence_bases === 100;
  const sequenceCount = short ? 1 : summary.contig_count;
  return <section className={styles.panel} aria-labelledby="prediction-information-heading">
    <div className={styles.panelHeader}><h2 id="prediction-information-heading">Prediction information</h2></div>
    <dl className={`${styles.factGrid} ${styles.resultFacts} ${styles.simpleResultFacts}`}>
      <div><dt>Input</dt><dd>{inputName}{refName && refName !== inputName ? <small>{refName}</small> : null}<small>{bases(short ? summary.sequence_bases : summary.total_bases)} · {sequenceCount?.toLocaleString() ?? 'Unknown'} {sequenceCount === 1 ? 'sequence' : 'sequences'}</small></dd></div>
      <div><dt>Prediction settings</dt><dd>{summary.reverse_complementary === undefined ? 'Strands not recorded' : summary.reverse_complementary ? 'Both strands' : 'Forward strand only'}{focused && summary.score_cutoff !== undefined ? <small>Cutoff: {summary.score_cutoff_operator || '>'} {summary.score_cutoff}</small> : !focused && (summary.peak_calling ? <small>Cutoff: {summary.peak_calling.operator} {summary.peak_calling.cutoff}</small> : <small>Cutoff: {exportCutoffLabel(summary)}</small>)}</dd></div>
      <div><dt>Model</dt><dd>RAPPtor</dd></div>
    </dl>
  </section>;
}
