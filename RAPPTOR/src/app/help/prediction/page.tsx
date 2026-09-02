import type { Metadata } from 'next';
import Link from 'next/link';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import styles from './prediction-help.module.css';

export const metadata: Metadata = {
  title: 'Prediction help | RAPPTOR',
  description: 'How to provide prediction input, read focused and scan results, use JBrowse 2 tracks, and download RAPPTOR prototype files.',
};

const sections = [
  { href: '#quick-start', label: 'Quick start' },
  { href: '#automatic-analysis', label: 'Automatic analysis' },
  { href: '#inputs', label: 'Add input' },
  { href: '#model-inputs', label: 'How inputs are read' },
  { href: '#parameters', label: 'Parameters' },
  { href: '#queue-status', label: 'Queue progress' },
  { href: '#results', label: 'Interpret results' },
  { href: '#browser', label: 'Genome browser' },
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
          <h1>Understand RAPPTOR prediction results</h1>
          <p>Add a sequence or genome, review the detected analysis, and read the result with its genome context and strand.</p>
          <div className="portal-actions">
            <Link href="/predict" className="portal-button portal-button-primary">Open prediction <ArrowForwardRoundedIcon fontSize="small" /></Link>
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
              <li><span>1</span><div><strong>Add sequence or genome input</strong><p>Use one input card to paste DNA or FASTA, or choose a FASTA file. The most recently accepted input is used for the result.</p></div></li>
              <li><span>2</span><div><strong>Add genome context for CGR</strong><p>Every Focused or Scan input needs the complete matching genome. Search the catalog or upload a genome FASTA before continuing.</p></div></li>
              <li><span>3</span><div><strong>Review the detected analysis</strong><p>Check the Focused or Scan label and the parameters shown for that input.</p></div></li>
              <li><span>4</span><div><strong>Follow queue progress</strong><p>The result URL first reports the current queue or processing stage. Result panels appear only after the task is ready.</p></div></li>
              <li><span>5</span><div><strong>Read the matching result</strong><p>Focused input shows a compact score panel. Scan input opens a JBrowse 2 view with reference, raw-score and called-peak tracks.</p></div></li>
            </ol>
            <div className={styles.cardGrid}>
              <div className={styles.card}>
                <span className={styles.cardLabel}>Built-in example</span>
                <h3>100 bp sequence</h3>
                <p>Use the short example to prepare a Focused result. Then explicitly provide its expected E. coli K-12 genome context.</p>
              </div>
              <div className={styles.card}>
                <span className={styles.cardLabel}>Built-in example</span>
                <h3>E. coli K-12 genome</h3>
                <p>Use the assembly metadata example for <code>GCF_000005845.2</code>, then provide the matching genome again as the CGR context before opening the scan result.</p>
              </div>
            </div>
            <div className={styles.demoNote}><strong>About this prototype</strong><p>Its scores, tracks and downloads are deterministic illustrations. No model was run, so they are not biological output.</p></div>
          </section>

          <section id="automatic-analysis">
            <p className="portal-kicker">Automatic analysis</p>
            <h2>The input determines the analysis</h2>
            <p>There is no analysis-mode selector. RAPPTOR applies the following rules after reading the input:</p>
            <div className={styles.cardGrid}>
              <div className={styles.card}>
                <span className={styles.cardLabel}>Detected: Focused 100 bp window</span>
                <h3>Exactly one 100 bp record</h3>
                <p>An input containing exactly one sequence record of exactly 100 bp is scored as one focused window. You must also select or upload the matching genome so RAPPTOR can obtain its CGR context.</p>
                <p>The result contains one raw score for each strand actually evaluated and its cutoff state.</p>
              </div>
              <div className={styles.card}>
                <span className={styles.cardLabel}>Detected: Sequence / contig scan</span>
                <h3>Longer sequence or contigs</h3>
                <p>A sequence longer than 100 bp, or a multi-record FASTA with total length above 100 bp and at least one record of 100 bp or more, is scanned using the selected step. The built-in E. coli K-12 genome example is also scanned.</p>
                <p>The submitted sequence is the scan target. A separate matching complete genome supplies the CGR context. The result opens in JBrowse 2.</p>
              </div>
            </div>
            <div className={styles.demoNote}><strong>Short contigs in a Scan</strong><p>Records shorter than 100 bp cannot form one model window. RAPPTOR skips them and reports how many were skipped. If every record is shorter than 100 bp, the input is rejected rather than producing an empty result.</p></div>
          </section>

          <section id="inputs">
            <p className="portal-kicker">Add input</p>
            <h2>Use one input card</h2>
            <p>Paste text and select a file in the same card. You do not need to choose an input type first. After the analysis is detected, a separate catalog or FASTA control collects the genome used for CGR.</p>
            <div className={styles.requirements}>
              <div><strong>Sequence input</strong><p>Paste up to 10,000 bases as raw DNA or FASTA. A, C, G, T and N are accepted; whitespace is ignored and U is normalized to T. Upload a FASTA for longer input.</p></div>
              <div><strong>FASTA file</strong><p>Use <code>.fa</code>, <code>.fasta</code> or <code>.fna</code>, optionally gzip-compressed, up to 50 MiB. Multiple FASTA records are treated as separate contigs.</p></div>
              <div><strong>Genome context for CGR</strong><p>Every score uses context from the same genome as the submitted sequence. Focused and Scan analyses both require an explicit catalog selection or matching genome FASTA.</p></div>
            </div>
          </section>

          <section id="model-inputs">
            <p className="portal-kicker">How inputs are read</p>
            <h2>Local sequence plus genome-wide context</h2>
            <h3>CGR context</h3>
            <p>A Chaos Game Representation (CGR) summarizes nucleotide-pattern frequencies across the matching genome as a 128 × 128 image. RAPPtor uses this global genome context alongside each local sequence window. It is not a genome browser image and does not identify a promoter by itself.</p>
            <h3>100 nt windows and the 80 + 20 anchor</h3>
            <p>RAPPtor reads 100 nt at a time: 80 nt on the upstream side of the prediction anchor and 20 nt on the downstream side, in transcription orientation. The anchor is the 80th base of the oriented window. Focused analysis scores its one exact window; Scan advances by the selected step on every eligible contig.</p>
            <h3>Strands</h3>
            <p><strong>Both strands</strong> evaluates forward and reverse-complement orientations and is the default when orientation is unknown. <strong>Forward only</strong> evaluates the submitted orientation. Always read the strand column together with the anchor coordinate.</p>
          </section>

          <section id="parameters">
            <p className="portal-kicker">Parameters</p>
            <h2>Controls shared by both analyses</h2>
            <dl className={styles.definitionList}>
              <div><dt>Strands</dt><dd>Shown for Focused and Scan. Choose both strands or forward only; this changes which oriented windows are evaluated.</dd></div>
              <div><dt>Score cutoff</dt><dd>Shown for Focused and Scan, with 0.90 as the default. It sets the Focused above-cutoff or below-cutoff state and filters Scan called peaks. It never changes raw scores.</dd></div>
              <div><dt>Step</dt><dd>Choose 1, 5, 10 or 20 nt. It sets the distance between consecutive windows in a Scan; a smaller value gives denser coverage and more windows. A Focused 100 bp input always contains one window.</dd></div>
            </dl>
            <p className={styles.readOnly}>The included model uses a 100 nt window, an 80/20 anchor layout and 128 × 128 CGR input. These model settings are fixed by the prototype.</p>
          </section>

          <section id="queue-status">
            <p className="portal-kicker">Queue progress</p>
            <h2>Know what the prediction service is doing</h2>
            <p>After submission, the result page moves through waiting in queue, preparing the genome CGR, scoring or scanning, preparing result files, and result ready. A genome scan may also report its current contig, strand and number of processed windows.</p>
            <div className={styles.requirements}>
              <div><strong>Queue status</strong><p><em>Waiting in queue</em> means the request was accepted but no worker has started it. RAPPTOR does not show a queue position or estimated completion time unless the service can measure them reliably.</p></div>
              <div><strong>Progress percentage</strong><p>The percentage describes job processing only. It is not a promoter score, accuracy, confidence or measure of biological support.</p></div>
              <div><strong>Refresh and failure</strong><p>Refreshing the same result URL restores progress from the saved run metadata or live service. A failed job keeps its error state and provides a status retry or return-to-input action.</p></div>
            </div>
            <div className={styles.demoNote}><strong>Prototype timing</strong><p>The browser-only prototype briefly simulates these stages to preview the queue interface. No model or real queue is used, and an older prototype run may already be complete when reopened.</p></div>
          </section>

          <section id="results">
            <p className="portal-kicker">Interpret results</p>
            <h2>Focused and scan results are different</h2>
            <div className={styles.compare}>
              <div><strong>Focused 100 bp result</strong><p>A compact comparison card shows each evaluated strand, its raw-score meter and cutoff state. There is no browser track, sliding score series or called peak for one exact window.</p></div>
              <div><strong>Sequence / contig scan</strong><p>Raw scores belong to overlapping oriented 100 nt windows. Called peaks are representative candidates selected from the raw-score series after peak calling and cutoff filtering.</p></div>
            </div>
            <div className={styles.interpretation}>
              <h3>How to interpret this result</h3>
              <ul>
                <li>Use scores to rank model output within the submitted context.</li>
                <li>In Scan results, inspect nearby windows before treating several adjacent rows as separate candidates.</li>
                <li>Confirm sequence ID, anchor and strand before comparing with an annotation.</li>
                <li>A high score or called peak is a computational prediction, not experimental validation.</li>
                <li>Raw score and called peak are different result types and should not be used interchangeably.</li>
              </ul>
            </div>
          </section>

          <section id="browser">
            <p className="portal-kicker">Genome browser</p>
            <h2>Read a scan in JBrowse 2</h2>
            <p>Every Sequence / contig scan uses JBrowse 2 as its main result view. Choose a contig and compare three separate tracks:</p>
            <div className={styles.requirements}>
              <div><strong>Reference sequence</strong><p>Shows the submitted sequence or the illustrative reference used when the original browser-memory input is unavailable.</p></div>
              <div><strong>Raw score</strong><p>Shows the deterministic score at each model-window anchor. It is a track of raw model output, not a peak list.</p></div>
              <div><strong>Called peak</strong><p>Shows candidates retained after peak calling and the selected cutoff. Changing the cutoff can change this track without changing the raw-score track.</p></div>
            </div>
            <div className={styles.demoNote}><strong>Illustrative tracks</strong><p>The E. coli K-12 example uses real assembly metadata and coordinates, but its local reference and prediction tracks are illustrative. They do not represent a model run on that genome.</p></div>
          </section>

          <section id="coordinates-downloads">
            <p className="portal-kicker">Coordinates &amp; downloads</p>
            <h2>Know the convention before joining files</h2>
            <p>On-screen anchors and GFF3 features use 1-based coordinates. bedGraph uses zero-based, half-open intervals. A Scan called peak is a 1 bp anchor, while a Focused GFF3 feature spans the complete evaluated 100 bp window.</p>
            <p>Both analyses provide only the two track formats used by the result view: bedGraph for strand-separated raw scores and GFF3 for strand-aware features.</p>
            <div className={styles.downloadGrid}>
              <div><strong>bedGraph</strong><span>Strand-separated 1 bp anchor intervals containing raw scores.</span></div>
              <div><strong>GFF3</strong><span>1-based 100 bp Focused windows or 1 bp Scan peaks.</span></div>
            </div>
          </section>

          <section id="privacy">
            <p className="portal-kicker">Privacy</p>
            <h2>What stays in your browser</h2>
            <p>For a paste or upload, the original DNA or FASTA stays only in short-lived browser memory while the result page opens. It is not written to <code>sessionStorage</code>, local storage, the URL or <code>/api/predictions</code>.</p>
            <p>The prototype stores only a versioned run summary in <code>sessionStorage</code>: detected analysis, parameter values, sequence lengths, record IDs, optional file name and checksum. It cannot restore the original sequence from that summary.</p>
            <p>If you reload, open a copied link or return after browser memory has cleared, the scan page safely shows a deterministic illustrative reference and tracks built from the stored metadata. It does not recover or upload your original input. A future live service will present its upload and retention rules before submission.</p>
          </section>

          <section id="faq">
            <p className="portal-kicker">FAQ</p>
            <h2>Common interpretation questions</h2>
            <div className={styles.faq}>
              <details><summary>Does a score above 0.90 prove that a promoter is present?</summary><p>No. It is a model-derived result at the selected cutoff, not an experimental observation.</p></details>
              <details><summary>Why does a Focused input need a matching genome?</summary><p>The 100 bp window is too local to supply genome-wide context. RAPPtor conditions its score on CGR from the genome that contains the sequence.</p></details>
              <details><summary>Can I choose Focused or Scan myself?</summary><p>No selection is needed. One exact 100 bp record is Focused; longer or valid multi-record input is a scan. The E. coli K-12 example is a scan.</p></details>
              <details><summary>Why does a scan open a genome browser?</summary><p>A scan has scores and called peaks at many positions. JBrowse 2 keeps the reference, raw-score and called-peak tracks aligned at the same coordinates.</p></details>
              <details><summary>Why are several high-scoring windows close together?</summary><p>Small step values create strongly overlapping windows. Peak calling summarizes a local score pattern into representative candidates.</p></details>
              <details><summary>What if no result passes the cutoff?</summary><p>The raw score series still exists. Lowering the display cutoff may reveal lower-ranked candidates, but it does not recalculate or improve their scores.</p></details>
              <details><summary>Are example downloads biological predictions?</summary><p>No. Deterministic fixtures explain the interface and file formats. No model was run for the prototype examples.</p></details>
            </div>
          </section>

          <section id="troubleshooting">
            <p className="portal-kicker">Troubleshooting</p>
            <h2>When prediction cannot continue</h2>
            <div className={styles.troubleshooting}>
              <div><strong>The sequence is rejected</strong><p>A single sequence shorter than 100 bp cannot form one model window. For multi-record FASTA, at least one contig must contain 100 bp or more.</p></div>
              <div><strong>The FASTA upload is rejected</strong><p>Check the extension, gzip suffix and 50 MiB limit. Confirm that the file is FASTA rather than an annotation file.</p></div>
              <div><strong>Some contigs are missing from Scan</strong><p>Check the skipped-contig notice. Records shorter than 100 bp are reported and omitted because no complete model window fits.</p></div>
              <div><strong>CGR genome catalog search fails</strong><p>Retry without clearing the submitted input, or upload the matching genome FASTA instead.</p></div>
              <div><strong>Queue progress stops updating</strong><p>Keep the result URL and retry the status check. Do not resubmit immediately: the queued worker may still be processing the original job.</p></div>
              <div><strong>The original scan reference is unavailable after reload</strong><p>This protects the input by design. The page shows an illustrative fallback built from stored metadata; return to prediction and add the sequence again to view the original browser-memory reference.</p></div>
            </div>
            <Link href="/predict" className={`portal-text-link ${styles.finalLink}`}>Return to prediction <ArrowForwardRoundedIcon fontSize="small" /></Link>
          </section>
        </article>
      </div>
    </main>
  );
}
