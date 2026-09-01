import type { Metadata } from 'next';
import Link from 'next/link';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import styles from './prediction-help.module.css';

export const metadata: Metadata = {
  title: 'Prediction help | RAPPTOR',
  description: 'How to prepare inputs, run a RAPPTOR prediction workflow and interpret scores, peaks, coordinates and downloads.',
};

const sections = [
  { href: '#quick-start', label: 'Quick start' },
  { href: '#workflows', label: 'Automatic analysis' },
  { href: '#inputs', label: 'Prepare inputs' },
  { href: '#model-inputs', label: 'How inputs are read' },
  { href: '#parameters', label: 'Parameters' },
  { href: '#results', label: 'Interpret results' },
  { href: '#coordinates-downloads', label: 'Coordinates & downloads' },
  { href: '#privacy', label: 'Privacy' },
  { href: '#faq', label: 'FAQ' },
  { href: '#troubleshooting', label: 'Troubleshooting' },
];

export default function PredictionHelpPage() {
  return (
    <main className={`portal-page ${styles.page}`}>
      <section className={styles.hero}>
        <div className="portal-shell">
          <p className="portal-kicker">Prediction help</p>
          <h1>Use RAPPTOR prediction results with the right context</h1>
          <p>Provide sequence input with its matching genome context. RAPPTOR selects the appropriate analysis automatically and shows only the controls and outputs that apply.</p>
          <div className="portal-actions">
            <Link href="/predict" className="portal-button portal-button-primary">Open prediction workspace <ArrowForwardRoundedIcon fontSize="small" /></Link>
            <a href="#quick-start" className="portal-button portal-button-secondary">Read the quick start</a>
          </div>
        </div>
      </section>

      <div className={`portal-shell ${styles.layout}`}>
        <nav className={styles.toc} aria-label="Prediction help contents">
          <strong>On this page</strong>
          {sections.map((section) => <a key={section.href} href={section.href}>{section.label}</a>)}
        </nav>

        <article className={styles.content}>
          <section id="quick-start">
            <p className="portal-kicker">Quick start</p>
            <h2>From input to an interpretable result</h2>
            <ol className={styles.steps}>
              <li><span>1</span><div><strong>Add the sequence to analyze</strong><p>Paste DNA, upload FASTA, or select a catalog genome. The record count and length determine the analysis.</p></div></li>
              <li><span>2</span><div><strong>Confirm the genome context</strong><p>A focused 100 bp sequence needs a separate matching genome. A scan uses the selected or uploaded genome as its own CGR context.</p></div></li>
              <li><span>3</span><div><strong>Review the detected analysis</strong><p>Check the Focused or Scan label and the parameters shown for that input.</p></div></li>
              <li><span>4</span><div><strong>Interpret before downloading</strong><p>Check whether a row is a raw window score or a called peak, then confirm its strand and coordinate convention.</p></div></li>
            </ol>
            <div className={styles.demoNote}><strong>About the current prototype</strong><p>Demo pages use deterministic illustrative scores. They always state “No model was run” and must not be treated as biological output.</p></div>
          </section>

          <section id="workflows">
            <p className="portal-kicker">Automatic analysis</p>
            <h2>The input determines what RAPPTOR runs</h2>
            <p>There is no analysis-mode selector. RAPPTOR applies the following rules after reading the input:</p>
            <div className={styles.cardGrid}>
              <div className={styles.card}>
                <span className={styles.cardLabel}>Detected: Focused</span>
                <h3>Exactly one 100 bp record</h3>
                <p>An input containing exactly one sequence record of exactly 100 bp is scored as one focused window. You must also select or upload the matching genome so RAPPTOR can obtain its CGR context.</p>
                <p>The result contains one raw score for each strand actually evaluated and its cutoff state.</p>
              </div>
              <div className={styles.card}>
                <span className={styles.cardLabel}>Detected: Scan</span>
                <h3>Longer or multi-record input</h3>
                <p>A single record longer than 100 bp, or a multi-record FASTA with total length above 100 bp and at least one record of 100 bp or more, is scanned at stride 1. A catalog genome is always a Scan.</p>
                <p>The selected or uploaded genome supplies both the scan target and its CGR context. Results include raw score series and called peaks.</p>
              </div>
            </div>
            <div className={styles.demoNote}><strong>Short contigs in a Scan</strong><p>Records shorter than 100 bp cannot form one model window. RAPPTOR skips them and reports how many were skipped. If every record is shorter than 100 bp, the input is rejected rather than producing an empty result.</p></div>
          </section>

          <section id="inputs">
            <p className="portal-kicker">Prepare inputs</p>
            <h2>Sequence and FASTA requirements</h2>
            <div className={styles.requirements}>
              <div><strong>Sequence input</strong><p>Paste up to 10,000 bases as raw DNA or FASTA. A, C, G, T and N are accepted; whitespace is ignored and U is normalized to T. Upload a FASTA for longer input.</p></div>
              <div><strong>Genome or contigs</strong><p>Use <code>.fa</code>, <code>.fasta</code> or <code>.fna</code>, optionally gzip-compressed, up to 50 MiB. Multiple FASTA records are treated as separate contigs.</p></div>
              <div><strong>Matching context</strong><p>Every score uses CGR context from the same genome. For Focused analysis this is a separate required selection or upload; for Scan it is the catalog assembly or uploaded scan input itself.</p></div>
            </div>
          </section>

          <section id="model-inputs">
            <p className="portal-kicker">How inputs are read</p>
            <h2>Local sequence plus genome-wide context</h2>
            <h3>CGR context</h3>
            <p>A Chaos Game Representation (CGR) summarizes nucleotide-pattern frequencies across the matching genome as a 128 × 128 image. RAPPtor uses this global genome context alongside each local sequence window. It is not a genome browser image and does not identify a promoter by itself.</p>
            <h3>100 nt windows and the 80 + 20 anchor</h3>
            <p>RAPPtor reads 100 nt at a time: 80 nt on the upstream side of the prediction anchor and 20 nt on the downstream side, in transcription orientation. The anchor is the 80th base of the oriented window. Focused analysis scores its one exact window; Scan advances by one base (stride 1), producing an overlapping score series on every eligible contig.</p>
            <h3>Strands</h3>
            <p><strong>Both strands</strong> evaluates forward and reverse-complement orientations and is the default when orientation is unknown. <strong>Forward only</strong> evaluates the submitted orientation. Always read the strand column together with the anchor coordinate.</p>
          </section>

          <section id="parameters">
            <p className="portal-kicker">Parameters</p>
            <h2>Controls adapt to the detected analysis</h2>
            <dl className={styles.definitionList}>
              <div><dt>Strands</dt><dd>Shown for Focused and Scan. Choose both strands or forward only; this changes which oriented windows are evaluated.</dd></div>
              <div><dt>Score cutoff</dt><dd>Shown for Focused and Scan, with 0.90 as the default. It sets the Focused pass/below-cutoff state or filters Scan peaks; changing it does not change any raw model score.</dd></div>
              <div><dt>Top results</dt><dd>Shown only for Scan. Choose 5, 10 or 20 called peaks to display. This changes the ranked table only, not the scan or its scores.</dd></div>
            </dl>
            <p className={styles.readOnly}>The included model uses a 100 nt window, an 80/20 anchor layout, 128 × 128 CGR input and stride 1. These model settings are shown for transparency and are not editable in the workspace.</p>
          </section>

          <section id="results">
            <p className="portal-kicker">Interpret results</p>
            <h2>Results adapt without changing what a score means</h2>
            <div className={styles.compare}>
              <div><strong>Focused result</strong><p>One raw score and cutoff state are shown for each strand actually evaluated. There is no sliding score curve or called peak for a single exact window.</p></div>
              <div><strong>Scan result</strong><p>Raw scores belong to overlapping oriented 100 nt windows. Called peaks are representative candidates selected from that score series by the backend peak-calling step and cutoff filtering.</p></div>
            </div>
            <div className={styles.interpretation}>
              <h3>How to interpret this result</h3>
              <ul>
                <li>Use scores to rank model output within the submitted context.</li>
                <li>In Scan results, inspect nearby windows before treating several adjacent rows as separate candidates.</li>
                <li>Confirm sequence ID, anchor and strand before comparing with an annotation.</li>
                <li>A high score or called peak is a computational prediction, not experimental validation.</li>
                <li>Do not read the score as accuracy or as a confidence interval.</li>
              </ul>
            </div>
          </section>

          <section id="coordinates-downloads">
            <p className="portal-kicker">Coordinates &amp; downloads</p>
            <h2>Know the convention before joining files</h2>
            <p>On-screen anchors and prototype JSON/TSV records are reported as 1-based positions. GFF3 uses 1-based inclusive coordinates; bedGraph and BED6 use 0-based half-open intervals. A Scan called peak is a 1 bp anchor, while a Focused feature spans the complete evaluated 100 bp window.</p>
            <p>JSON, TSV, bedGraph, GFF3 and BED6 are available for both analyses, but their rows follow the result. bedGraph contains 1 bp anchor intervals for raw scores in both analyses. Focused GFF3/BED6 features cover the evaluated 100 bp window; Scan GFF3/BED6 features are 1 bp called-peak anchors.</p>
            <div className={styles.downloadGrid}>
              <div><strong>JSON</strong><span>Structured run metadata, detected analysis, parameters and results.</span></div>
              <div><strong>TSV</strong><span>Focused strand scores or ranked Scan peaks.</span></div>
              <div><strong>bedGraph</strong><span>1 bp anchor intervals containing raw scores.</span></div>
              <div><strong>GFF3</strong><span>1-based 100 bp Focused windows or 1 bp Scan peaks.</span></div>
              <div><strong>BED6</strong><span>0-based 100 bp Focused windows or 1 bp Scan peaks, with strand.</span></div>
              <div><strong>Parquet</strong><span>Reserved for the future live service; unavailable in the prototype.</span></div>
            </div>
          </section>

          <section id="privacy">
            <p className="portal-kicker">Privacy</p>
            <h2>What the prototype stores</h2>
            <p>The prototype keeps only a versioned run summary in <code>sessionStorage</code>: detected analysis, parameter values, sequence lengths, optional file name and checksum. It does not store raw sequence or FASTA content there, and it does not submit prototype input to <code>/api/predictions</code>.</p>
            <p>Session data is limited to the current browser tab and may disappear when the tab is closed or browser storage is cleared. A future live service will present its upload and retention rules before submission.</p>
          </section>

          <section id="faq">
            <p className="portal-kicker">FAQ</p>
            <h2>Common interpretation questions</h2>
            <div className={styles.faq}>
              <details><summary>Does a score above 0.90 prove that a promoter is present?</summary><p>No. It is a model-derived result at the selected cutoff, not an experimental observation.</p></details>
              <details><summary>Why does a Focused input need a matching genome?</summary><p>The 100 bp window is too local to supply genome-wide context. RAPPtor conditions its score on CGR from the genome that contains the sequence.</p></details>
              <details><summary>Can I choose Focused or Scan myself?</summary><p>No selection is needed. One exact 100 bp record is Focused; longer or valid multi-record input is Scan. Catalog genomes are always scanned.</p></details>
              <details><summary>Why are several high-scoring windows close together?</summary><p>Stride-1 windows overlap extensively. Peak calling summarizes a local score pattern into representative candidates.</p></details>
              <details><summary>What if no result passes the cutoff?</summary><p>The raw score series still exists. Lowering the display cutoff may reveal lower-ranked candidates, but it does not recalculate or improve their scores.</p></details>
              <details><summary>Are demo downloads biological predictions?</summary><p>No. Deterministic fixtures exist to explain the interface and file formats. Look for the “No model was run” notice.</p></details>
            </div>
          </section>

          <section id="troubleshooting">
            <p className="portal-kicker">Troubleshooting</p>
            <h2>When the workflow cannot continue</h2>
            <div className={styles.troubleshooting}>
              <div><strong>The sequence is rejected</strong><p>A single sequence shorter than 100 bp cannot form one model window. For multi-record FASTA, at least one contig must contain 100 bp or more.</p></div>
              <div><strong>The FASTA upload is rejected</strong><p>Check the extension, gzip suffix and 50 MiB limit. Confirm that the file is FASTA rather than an annotation file.</p></div>
              <div><strong>Some contigs are missing from Scan</strong><p>Check the skipped-contig notice. Records shorter than 100 bp are reported and omitted because no complete model window fits.</p></div>
              <div><strong>Catalog search fails</strong><p>Retry without clearing your sequence, switch to FASTA upload, or use the built-in paired example, which does not depend on the catalog.</p></div>
              <div><strong>A demo result is missing</strong><p>Prototype runs live in session storage. Return to the workspace and create a new demo run if the tab or stored session was cleared.</p></div>
            </div>
            <span className={`portal-text-link ${styles.finalLink}`} aria-disabled="true">Return to prediction workspace</span>
          </section>
        </article>
      </div>
    </main>
  );
}
