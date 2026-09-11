import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import { RESULT_TABLE_FILENAME, SCORE_TRACKS_ZIP_FILENAME, SCORE_TRACK_FILENAMES, resultTableSource, type JobArtifact, type JobSummary } from '../live-result';
import styles from '../prototype-result.module.css';

export default function ResultDownloads({ jobId, artifacts, mode, expiresAt, bigwigSmoothing }: {
  jobId: string; artifacts: JobArtifact[]; mode: JobSummary['mode']; expiresAt: string;
  bigwigSmoothing?: JobSummary['bigwig_smoothing'];
}) {
  const base = `/api/predictions/jobs/${jobId}/artifacts`;
  const table = mode === 'predict' && resultTableSource(artifacts, mode);
  const promoters = artifacts.find((item) => item.filename === 'promoters.gff3' || item.filename === 'peaks.gff3');
  const positions = promoters || artifacts.find((item) => item.filename === 'scores.gff3');
  const tracks = SCORE_TRACK_FILENAMES.filter((name) => artifacts.some((item) => item.filename === name));
  const smoothedTracks = bigwigSmoothing?.method === 'gaussian' && bigwigSmoothing.mode === 'reflect';
  const trackDescription = tracks.length === 2
    ? `${smoothedTracks ? 'Gaussian-smoothed' : 'Raw'} forward and reverse BigWig files in one folder.`
    : `${smoothedTracks ? 'Gaussian-smoothed' : 'Raw'} BigWig file for the available strand.`;
  const legacy = !table && !positions && !tracks.length
    ? artifacts.find((item) => item.filename === 'scores.parquet' || item.filename === 'scores.json') : undefined;
  return <section className={styles.panel} aria-labelledby="download-heading">
    <div className={styles.panelHeader}><h2 id="download-heading">Download result</h2><p>Temporary result files are available until {expiresAt}.</p></div>
    <div className={styles.primaryDownloads}>
      {table && <a className={styles.resultDownload} href={`${base}/${RESULT_TABLE_FILENAME}`} download>
        <DownloadRoundedIcon aria-hidden="true" /><span><strong>Prediction results <small>TSV</small></strong><span>One row per exported window, with coordinates, strand and model score.</span></span>
      </a>}
      {positions && <a className={styles.resultDownload} href={`${base}/${positions.filename}`} download>
        <DownloadRoundedIcon aria-hidden="true" /><span><strong>{promoters ? 'Predicted promoters' : 'Prediction results'} <small>GFF3</small></strong><span>{promoters ? '100 bp promoter prediction intervals with coordinates, strands and model scores.' : 'Predicted promoter positions, strands and model scores.'}</span></span>
      </a>}
      {tracks.length > 0 && <a className={styles.resultDownload} href={`${base}/${SCORE_TRACKS_ZIP_FILENAME}`} download>
        <DownloadRoundedIcon aria-hidden="true" /><span><strong>Model score tracks <small>ZIP</small></strong><span>{trackDescription} Includes scores below the export cutoff.</span></span>
      </a>}
      {legacy && <a className={styles.resultDownload} href={`${base}/${legacy.filename}`} download>
        <DownloadRoundedIcon aria-hidden="true" /><span><strong>Model scores <small>{legacy.format.toUpperCase()}</small></strong><span>Original score file from this task.</span></span>
      </a>}
    </div>
    {mode !== 'predict' && !positions && <p className={styles.downloadNote}>GFF3 is unavailable for this task.</p>}
    {mode === 'predict' && !table && !legacy && <p className={styles.downloadNote}>Result files are unavailable for this task.</p>}
  </section>;
}
