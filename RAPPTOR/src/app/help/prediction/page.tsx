import type { Metadata } from 'next';
import Link from 'next/link';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import styles from './prediction-help.module.css';

export const metadata: Metadata = {
  title: 'Prediction help | RAPPTOR',
  description: 'How to configure a RAPPTOR prediction and interpret its results.',
};

export default function PredictionHelpPage() {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div className="portal-shell">
          <p className="portal-kicker">RAPPTOR prediction</p>
          <h1>Prediction help</h1>
          <p>Configure the prediction sequence, reference-genome context, and model parameters, then interpret the resulting scores and promoter calls.</p>
        </div>
      </header>

      <div className={`portal-shell ${styles.layout}`}>
        <div className={styles.content}>
          <section id="workflow">
            <h2>Prediction workflow</h2>
            <ol className={styles.steps}>
              <li>
                <span>1</span>
                <div>
                  <strong>Provide the sequence for prediction</strong>
                  <p>An input of exactly 100 bp is evaluated once per selected strand. Longer inputs are scanned as overlapping 100 bp windows. Inputs shorter than 100 bp are not supported.</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Select the complete reference genome</strong>
                  <p>Select the genome from which the input sequence was obtained. The reference genome provides the genomic context used during prediction.</p>
                  <div className={styles.stepDetail}>
                    <h3>Genome context and CGR</h3>
                    <p>CGR (Chaos Game Representation) encodes DNA sequence patterns across the selected complete reference genome. RAPPTOR uses this representation as genomic context when evaluating the Step 1 sequence. The CGR is generated automatically; no CGR file is required.</p>
                    <p>Select the same strain and assembly version from which the input sequence was obtained. A different reference genome provides a different genomic context and may alter the prediction result.</p>
                  </div>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Configure prediction parameters</strong>
                  <p>Select the strand mode and, for sequence scans, the promoter cutoff and stride.</p>
                  <dl className={styles.stepParameters}>
                    <div><dt>Strands</dt><dd>Select Both when sequence orientation is unknown. Forward evaluates the submitted orientation; Reverse evaluates its reverse complement.</dd></div>
                    <div><dt>Promoter cutoff</dt><dd>Defines the minimum score considered during promoter reporting. The default is appropriate for standard predictions.</dd></div>
                    <div><dt>Stride</dt><dd>Defines the distance between consecutive 100 bp windows. A stride of 1 provides base-level sampling; larger strides sample fewer positions.</dd></div>
                  </dl>
                </div>
              </li>
            </ol>

            <div className={styles.faq}>
              <details>
                <summary>Sequence and reference requirements</summary>
                <p>Raw DNA and FASTA input are supported. Reference files may use <code>.fa</code>, <code>.fasta</code>, or <code>.fna</code>, optionally gzip-compressed. Standard IUPAC DNA characters are accepted; U is interpreted as T and ambiguous bases as N.</p>
              </details>
              <details>
                <summary>Parameter behavior</summary>
                <p>The cutoff affects promoter reporting, not the underlying model scores. Increasing stride accelerates a scan but reduces positional resolution because fewer windows are evaluated.</p>
              </details>
            </div>
          </section>

          <section id="results">
            <h2>Interpreting prediction results</h2>
            <dl className={styles.definitionList}>
              <div><dt>Model score</dt><dd>Higher scores indicate that a 100 bp window is more promoter-like for the selected model and genomic context. A model score is neither a probability nor experimental evidence.</dd></div>
              <div><dt>Promoter call</dt><dd>At stride 1, a reported promoter must be a local maximum above the selected cutoff. A score above the cutoff is therefore not sufficient by itself to produce a promoter call.</dd></div>
              <div><dt>Score track</dt><dd>BigWig tracks retain the complete set of computed scores, including values below the promoter cutoff.</dd></div>
              <div><dt>Promoter track</dt><dd>GFF3 records contain the genomic positions, strands, and scores of reported promoter predictions.</dd></div>
            </dl>

            <div className={styles.interpretation}>
              <h3>Interpretation boundary</h3>
              <p>RAPPTOR results are computational predictions. They do not establish experimental promoter activity or identify a transcription start site.</p>
            </div>

            <div className={styles.faq}>
              <details>
                <summary>How promoter calls are generated</summary>
                <p>For stride 1, scores are Gaussian-smoothed by strand before local maxima are identified and filtered by the promoter cutoff. For larger strides, each sampled raw-score window above the cutoff is reported directly.</p>
              </details>
              <details>
                <summary>Result files and retention</summary>
                <p>Use GFF3 for discrete promoter intervals and BigWig for continuous score visualization in a genome browser. Result artifacts are temporary and should be downloaded before the expiry time shown on the task page.</p>
              </details>
            </div>
          </section>

          <section id="troubleshooting">
            <h2>Troubleshooting</h2>
            <div className={styles.faq}>
              <details>
                <summary>Reference genome not found</summary>
                <p>Search with a versioned <code>GCA_</code> or <code>GCF_</code> accession. If the assembly is unavailable, upload its complete-genome FASTA.</p>
              </details>
              <details>
                <summary>FASTA input rejected</summary>
                <p>Verify the file extension, confirm that records are non-empty, and check the displayed size limit. Sequences shorter than 100 bp cannot be evaluated.</p>
              </details>
              <details>
                <summary>No promoters reported</summary>
                <p>Inspect the score tracks before changing the cutoff. At stride 1, windows above the cutoff must also be local maxima to be reported as promoters.</p>
              </details>
              <details>
                <summary>Task failed or results expired</summary>
                <p>Confirm the prediction sequence and reference genome, then submit a new task. Expired result artifacts cannot be recovered from the task page.</p>
              </details>
            </div>

            <p className={styles.finalLink}><Link className="portal-button portal-button-primary" href="/predict">Back to prediction <ArrowForwardRoundedIcon fontSize="small" /></Link></p>
          </section>
        </div>
      </div>
    </main>
  );
}
