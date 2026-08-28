import type { Metadata } from 'next';
import Link from 'next/link';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import { cyanobacteriaRelease } from '@/features/cyanobacteria/catalog';

export const metadata: Metadata = {
  title: 'Cyanobacteria collection | RAPPTOR',
  description: 'Three cyanobacterial genomes with predicted promoters and genome annotations.',
};

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

export default function CyanobacteriaPage() {
  return (
    <main className="portal-page cyanobacteria-page">
      <section className="cyanobacteria-hero">
        <div className="portal-shell cyanobacteria-hero-layout">
          <div>
            <h1>Cyanobacterial promoter predictions</h1>
            <p>Three genome-resolved case studies with final RAPPTOR promoter calls and contextual genome annotations.</p>
          </div>
          <dl className="cyanobacteria-release-summary">
            <div><dt>Genomes</dt><dd>{cyanobacteriaRelease.totalGenomes}</dd></div>
            <div><dt>Predicted promoters</dt><dd>{formatNumber(cyanobacteriaRelease.totalPredictedPromoters)}</dd></div>
          </dl>
        </div>
      </section>

      <section className="portal-shell cyanobacteria-collection" aria-labelledby="cyanobacteria-genomes-heading">
        <div className="cyanobacteria-section-heading">
          <div><p className="portal-kicker">Genome browsers</p><h2 id="cyanobacteria-genomes-heading">Open a genome</h2></div>
          <p>Final promoter predictions use the model score &gt; 0.9 rule.</p>
        </div>
        <div className="cyanobacteria-card-grid">
          {cyanobacteriaRelease.genomes.map((genome) => (
            <article className="cyanobacteria-card" key={genome.id}>
              <header>
                <span>{genome.identifierType}</span>
                <code>{genome.id}</code>
                <h3><i>{genome.organismName.split(' PCC ')[0]}</i>{genome.organismName.includes(' PCC ') ? ` PCC ${genome.organismName.split(' PCC ')[1]}` : ''}</h3>
                <p>Strain {genome.strain}</p>
              </header>
              <dl>
                <div><dt>Genome</dt><dd>{formatNumber(genome.genomeSizeBp)} bp · {genome.contigCount} {genome.contigCount === 1 ? 'contig' : 'contigs'}</dd></div>
                <div><dt>Predicted promoters</dt><dd>{formatNumber(genome.predictedPromoterCount)}</dd></div>
                <div><dt>Annotation</dt><dd>{genome.annotation.label}</dd></div>
              </dl>
              <Link href={`/cyanobacteria/${encodeURIComponent(genome.id)}`} className="cyanobacteria-card-link">Open genome browser <ArrowForwardRoundedIcon aria-hidden="true" /></Link>
            </article>
          ))}
        </div>
      </section>

    </main>
  );
}
