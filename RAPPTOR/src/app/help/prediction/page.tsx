import type { Metadata } from 'next';
import Link from 'next/link';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import styles from './prediction-help.module.css';

export const metadata: Metadata = {
  title: 'Prediction help | RAPPTOR',
  description: 'How to choose RAPPTOR prediction inputs, genome context, scan settings, and result files.',
};

export default function PredictionHelpPage() {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div className="portal-shell">
          <p className="portal-kicker">RAPPTOR prediction</p>
          <h1>Prediction help</h1>
          <p>Choose the input, genome context, and scan settings before you queue a prediction.</p>
        </div>
      </header>
      <div className={`portal-shell ${styles.layout}`}>
        <nav className={styles.toc} aria-label="Help sections">
          <strong>On this page</strong>
          <a href="#choose">Choose an analysis</a>
          <a href="#inputs">Inputs and CGR</a>
          <a href="#results">Read results</a>
          <a href="#troubleshooting">Troubleshooting</a>
        </nav>
        <div className={styles.content}>
          <section id="choose">
            <h2>Choose an analysis</h2>
            <p>RAPPTOR selects the analysis from the length and format of the sequence in Step 1.</p>
            <div className={styles.compare}>
              <div>
                <h3>100 bp scoring</h3>
                <p>Use exactly 100 bp to score one candidate sequence. RAPPTOR returns one model score for each selected strand.</p>
              </div>
              <div>
                <h3>Sequence scan</h3>
                <p>Any input longer than 100 bp is scanned with overlapping 100 bp windows. The input can be a region, a contig, or a complete genome.</p>
              </div>
            </div>
            <ol className={styles.steps}>
              <li><span>1</span><div><strong>Add the sequence to score</strong><p>Paste raw DNA or FASTA, upload FASTA, or choose a catalog genome.</p></div></li>
              <li><span>2</span><div><strong>Choose the genome context</strong><p>Select or upload a complete genome for the CGR background.</p></div></li>
              <li><span>3</span><div><strong>Set scan options</strong><p>Choose strands, cutoff, and stride when those options apply.</p></div></li>
              <li><span>4</span><div><strong>Review and save results</strong><p>Read the scores and download result files before temporary artifacts expire.</p></div></li>
            </ol>
          </section>

          <section id="inputs">
            <h2>Inputs and CGR</h2>
            <p>Step 1 is the sequence RAPPTOR scores. Step 2 is the complete genome used to build the genome context (CGR). The selected CGR genome defines the background in which the target sequence is evaluated.</p>
            <div className={styles.experimentNote}>
              <h3>How to interpret the CGR choice</h3>
              <p>RAPPTOR scores the target sequence together with the CGR built from the selected complete genome. Read the result as: “How promoter-like is this sequence in the context of this genome?” Using the sequence’s source strain and assembly gives the most direct interpretation for follow-up experiments. A different genome is also valid for a context comparison, but it produces a score conditioned on that genome and should be reported with the result.</p>
            </div>
            <div className={styles.requirements}>
              <div><strong>Sequence to score</strong><p>Exactly 100 bp runs one short-sequence prediction. Longer input starts a sequence scan. Standard IUPAC DNA characters are accepted; U is treated as T and ambiguous bases are treated as N.</p></div>
              <div><strong>Genome context</strong><p>Choose a catalog assembly or upload a complete FASTA. Accepted files are <code>.fa</code>, <code>.fasta</code>, or <code>.fna</code>, optionally gzip-compressed, within the displayed size limit.</p></div>
            </div>
          </section>

          <section id="results">
            <h2>Read results</h2>
            <dl className={styles.definitionList}>
              <div><dt>Model score</dt><dd>Higher scores indicate more promoter-like windows for the selected model and strand. The score is not experimental evidence or a probability of promoter activity.</dd></div>
              <div><dt>Model threshold</dt><dd>For exactly 100 bp, the threshold changes only the Promoter/Non-promoter label; it does not change the model score.</dd></div>
              <div><dt>Scored windows</dt><dd>All 100 bp windows evaluated by the model. This count can be larger than the number of exported predictions.</dd></div>
              <div><dt>Export cutoff</dt><dd>For sequence scans, only results above this value are exported as promoter predictions. Score tracks retain all computed windows.</dd></div>
              <div><dt>Predicted promoters</dt><dd>Windows or intervals reported after cutoff and promoter-calling rules. This count can differ from scored or exported-window counts.</dd></div>
              <div><dt>Downloads</dt><dd>GFF3 contains promoter intervals; BigWig contains score tracks, including scores below the cutoff. Files are temporary and should be saved before expiry.</dd></div>
            </dl>
            <div className={styles.interpretation}>
              <h3>Evidence boundary</h3>
              <p>A RAPPTOR result is a computational prediction. It does not establish experimental promoter activity or a transcription start site.</p>
            </div>
          </section>

          <section id="troubleshooting">
            <h2>Troubleshooting</h2>
            <div className={styles.troubleshooting}>
              <div><strong>No assembly found</strong><p>Try a versioned <code>GCA_</code>/<code>GCF_</code> accession or upload a complete FASTA.</p></div>
              <div><strong>FASTA rejected</strong><p>Check the extension, non-empty records, and the displayed size limit. Short contigs below 100 bp are not scanned.</p></div>
              <div><strong>No predictions were exported</strong><p>Lower the scan cutoff or inspect the score tracks. No exported interval does not mean that no windows were evaluated.</p></div>
              <div><strong>Task is queued</strong><p>You can leave the page and return through the task link. Queue estimates are approximate.</p></div>
              <div><strong>Task failed or expired</strong><p>Check the input and genome context, then resubmit. Temporary result links and artifacts expire.</p></div>
            </div>
            <p className={styles.finalLink}><Link className="portal-button portal-button-primary" href="/predict">Back to prediction <ArrowForwardRoundedIcon fontSize="small" /></Link></p>
          </section>
        </div>
      </div>
    </main>
  );
}
