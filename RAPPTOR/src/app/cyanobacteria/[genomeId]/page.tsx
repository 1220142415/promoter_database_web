import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import GenomeFileStatus from '@/features/genome-browser/components/genome-file-status';
import PortalBrowserPanel from '@/features/genome-browser/components/portal-browser-panel';
import { cyanobacteriaRelease, getCyanobacteriaGenome } from '@/features/cyanobacteria/catalog';

function formatNumber(value: number, suffix = '') {
  return `${new Intl.NumberFormat('en-US').format(value)}${suffix}`;
}

function dataUrl(genomeId: string, file: string) {
  return `/api/cyanobacteria-data/${encodeURIComponent(genomeId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export function generateStaticParams() {
  return cyanobacteriaRelease.genomes.map((genome) => ({ genomeId: genome.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ genomeId: string }> }): Promise<Metadata> {
  const { genomeId } = await params;
  const genome = getCyanobacteriaGenome(decodeURIComponent(genomeId));
  return genome
    ? { title: `${genome.id} cyanobacteria browser | RAPPTOR`, description: `${genome.organismName} promoter predictions and genome annotation.` }
    : { title: 'Cyanobacteria genome not found | RAPPTOR' };
}

export default async function CyanobacteriaGenomePage({ params }: { params: Promise<{ genomeId: string }> }) {
  const { genomeId } = await params;
  const genome = getCyanobacteriaGenome(decodeURIComponent(genomeId));
  if (!genome) notFound();
  const assetBase = `/api/cyanobacteria-data/${encodeURIComponent(genome.id)}`;
  const assembly = {
    assemblyName: genome.id,
    defaultLocus: genome.defaultLocus,
    assetBase,
    regionExportBase: '/api/cyanobacteria-region',
    adapterMode: 'indexed' as const,
    annotationTrackKind: 'annotation' as const,
    assets: genome.assets,
    trackLabels: {
      scores: 'Raw prediction scores (+ / - strands)',
      promoters: 'Predicted promoters (score > 0.9)',
      experimentalTss: genome.experimentalEvidence?.label,
      annotation: genome.annotation.label,
    },
  };
  const featureCounts = Object.entries(genome.annotation.featureCounts);
  const downloads: Array<readonly [string, string, string]> = [
    ['Reference sequence', genome.assets.fasta, 'BGZF-compressed FASTA and browser indexes'],
    ['Final promoter predictions', genome.assets.predictedPromoters, 'Score > 0.9 promoter_peak records'],
    ...(genome.experimentalEvidence && genome.assets.experimentalTss
      ? [[genome.experimentalEvidence.label, genome.assets.experimentalTss, 'Study-linked experimentally supported TSS observations'] as const]
      : []),
    [genome.annotation.label, genome.assets.ncbiAnnotations!, 'Genome-context feature annotations'],
  ];

  return (
    <main className="portal-page genome-detail-page cyanobacteria-detail-page">
      <section className="portal-shell detail-grid">
        <div className="detail-main">
          <section className="detail-section genome-browser-section">
            <header className="genome-browser-header">
              <Link href="/cyanobacteria" className="back-link"><ArrowBackRoundedIcon fontSize="small" /> Cyanobacteria collection</Link>
              <div className="detail-title-row">
                <div><p className="portal-kicker">{genome.identifierType} {genome.id}</p><h1>{genome.organismName}</h1><p className="detail-strain">Strain {genome.strain}</p></div>
                <div className="release-stamp"><span>Collection release</span><strong>{cyanobacteriaRelease.releaseId}</strong></div>
              </div>
            </header>
            <GenomeFileStatus states={{
              reference: 'available',
              scores: 'available',
              promoters: 'available',
              ...(genome.experimentalEvidence ? { experimentalTss: 'available' as const } : {}),
              annotation: 'available',
            }} />
            <PortalBrowserPanel assembly={assembly} />
          </section>
        </div>

        <section className="genome-metadata-section" aria-labelledby="cyanobacteria-summary-heading">
          <div className="genome-metadata-heading"><h2 id="cyanobacteria-summary-heading">Genome and prediction summary</h2></div>
          <div className="genome-metrics-grid" aria-label="Cyanobacteria genome key metrics">
            <div className="genome-metric"><span>Genome size</span><strong>{formatNumber(genome.genomeSizeBp, ' bp')}</strong></div>
            <div className="genome-metric"><span>GC content</span><strong>{genome.gcContent.toFixed(2)}%</strong></div>
            <div className="genome-metric"><span>Predicted promoters</span><strong>{formatNumber(genome.predictedPromoterCount)}</strong></div>
            {genome.experimentalEvidence ? <div className="genome-metric"><span>Experimental TSS observations</span><strong>{formatNumber(genome.experimentalEvidence.observationCount)}</strong></div> : null}
          </div>

          <div className={`cyanobacteria-detail-grid${genome.experimentalEvidence ? ' has-experimental-evidence' : ''}`}>
            {genome.experimentalEvidence ? <section className="cyanobacteria-method-card cyanobacteria-experimental-card">
              <p className="portal-kicker">Literature evidence</p>
              <h3>{genome.experimentalEvidence.label}</h3>
              <p>{genome.experimentalEvidence.title}</p>
              <dl>
                <div><dt>Study</dt><dd>{genome.experimentalEvidence.studyId}</dd></div>
                <div><dt>Observations</dt><dd>{formatNumber(genome.experimentalEvidence.observationCount)}</dd></div>
                <div><dt>Unique TSS</dt><dd>{formatNumber(genome.experimentalEvidence.uniqueTssCount)}</dd></div>
                <div><dt>Publication</dt><dd><a href={`https://pubmed.ncbi.nlm.nih.gov/${genome.experimentalEvidence.pmid}/`} target="_blank" rel="noreferrer">PMID {genome.experimentalEvidence.pmid}</a></dd></div>
              </dl>
              <p className="cyanobacteria-limitation">{genome.experimentalEvidence.methodBoundary}</p>
            </section> : null}
            <section className="cyanobacteria-method-card">
              <p className="portal-kicker">Annotation source</p>
              <h3>{genome.annotation.label}</h3>
              <p>{genome.annotation.description}</p>
              <dl>{featureCounts.map(([name, count]) => <div key={name}><dt>{name}</dt><dd>{formatNumber(count)}</dd></div>)}</dl>
              {genome.annotation.limitations ? <p className="cyanobacteria-limitation">{genome.annotation.limitations}</p> : null}
            </section>
          </div>

          <section className="cyanobacteria-downloads" aria-labelledby="cyanobacteria-downloads-heading">
            <div><p className="portal-kicker">Data access</p><h3 id="cyanobacteria-downloads-heading">Genome files</h3></div>
            <div className="release-downloads">
              {downloads.map(([label, file, description]) => <a href={dataUrl(genome.id, file)} download key={file}><span><strong>{label}</strong><small>{description}</small></span><DownloadRoundedIcon aria-hidden="true" /></a>)}
              <a href={dataUrl('release', cyanobacteriaRelease.manifest)} download><span><strong>Release manifest</strong><small>File sizes and SHA-256 digests for the complete collection</small></span><DownloadRoundedIcon aria-hidden="true" /></a>
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}
