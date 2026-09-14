import type { Metadata } from 'next';
import Link from 'next/link';
import styles from './prediction-help.module.css';

export const metadata: Metadata = {
  title: 'Prediction help | RAPPTOR',
  description: 'Short guidance for RAPPTOR promoter prediction inputs and results.',
};

export default function PredictionHelpPage() {
  return <main className={styles.page}>
    <header className={styles.hero}><div className="portal-shell"><p className="portal-kicker">RAPPTOR prediction</p><h1>Prediction help</h1><p>短说明，帮助你在需要时确认输入、参考基因组和结果含义。</p></div></header>
    <div className={`portal-shell ${styles.layout}`}>
      <nav className={styles.toc} aria-label="Help sections"><strong>On this page</strong><a href="#choose">Choose an analysis</a><a href="#inputs">Inputs and CGR</a><a href="#results">Read results</a><a href="#troubleshooting">Troubleshooting</a></nav>
      <div className={styles.content}>
        <section id="choose"><h2>Choose an analysis</h2><div className={styles.compare}><div><h3>100 bp scoring</h3><p>Paste one candidate sequence or one FASTA record. RAPPTOR scores the forward and reverse orientations of each 100 bp window.</p></div><div><h3>Sequence scan</h3><p>Choose a complete FASTA or catalog genome to score many overlapping windows. Stride controls the sampling interval.</p></div></div></section>
        <section id="inputs"><h2>Inputs and CGR</h2><p>The genome context (CGR) is the complete reference background used by the model. Select the matching catalog assembly or upload a complete FASTA; the site does not prove that a pasted short sequence came from that assembly.</p><div className={styles.requirements}><div><strong>Candidate</strong><p>DNA or one FASTA record; A, C, G, T and N are accepted.</p></div><div><strong>Genome FASTA</strong><p><code>.fa</code>, <code>.fasta</code>, or <code>.fna</code>, optionally gzip-compressed, within the displayed size limit.</p></div></div></section>
        <section id="results"><h2>Read results</h2><dl className={styles.definitionList}><div><dt>Model score</dt><dd>A score from the model for a window and strand.</dd></div><div><dt>Model threshold</dt><dd>For 100 bp scoring, it changes the positive/negative classification only; it does not change the score.</dd></div><div><dt>Export cutoff</dt><dd>For genome scans, it filters exported promoter predictions. Score tracks retain computed windows.</dd></div><div><dt>Stride</dt><dd>The bases between sampled windows. Larger values reduce sampling density and output size.</dd></div></dl><div className={styles.interpretation}><h3>Evidence boundary</h3><p>A RAPPTOR result is a computational prediction. It is not experimental TSS evidence or proof of promoter activity.</p></div></section>
        <section id="troubleshooting"><h2>Troubleshooting</h2><div className={styles.troubleshooting}><div><strong>No assembly found</strong><p>Try a versioned <code>GCA_</code>/<code>GCF_</code> accession or upload the complete FASTA.</p></div><div><strong>FASTA rejected</strong><p>Check the extension, complete records and displayed size limit.</p></div><div><strong>Task is queued</strong><p>You may close the page and return through the task link. Queue estimates are approximate.</p></div><div><strong>Task failed or expired</strong><p>Check the reference and resubmit. Temporary result links and artifacts expire.</p></div></div><p className={styles.finalLink}><Link href="/predict">Back to prediction</Link></p></section>
      </div>
    </div>
  </main>;
}
