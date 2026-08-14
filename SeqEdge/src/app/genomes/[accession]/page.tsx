import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import PortalBrowserPanel from '@/components/portal-browser-panel';
import { genomeCatalogRepository } from '@/lib/genome-catalog-repository';

function formatNumber(value: number | null, suffix = '') {
  return value === null ? 'Not reported' : `${value.toLocaleString()}${suffix}`;
}

export const dynamic = 'force-dynamic';

const findGenome = cache((accession: string) => genomeCatalogRepository.getByAccession(accession));

export async function generateMetadata({ params }: { params: Promise<{ accession: string }> }): Promise<Metadata> {
  const { accession } = await params;
  const match = await findGenome(decodeURIComponent(accession));
  return match ? { title: `${match.genome.accession} | SeqEdge`, description: `${match.genome.organismName} genome release details and promoter tracks.` } : { title: 'Genome not found | SeqEdge' };
}

export default async function GenomeDetailPage({ params }: { params: Promise<{ accession: string }> }) {
  const { accession } = await params;
  const match = await findGenome(decodeURIComponent(accession));
  if (!match) notFound();
  const { releaseId, assetBase, genome } = match;
  const defaultLocus = genome.defaultLocus || `${genome.primarySequence || genome.accession}:1-10000`;
  const browserAssets = genome.annotationStatus === 'available'
    ? genome.assets
    : { ...genome.assets, ncbiAnnotations: null, ncbiAnnotationsIndex: null };
  const regionExportBase = process.env.NEXT_PUBLIC_REGION_EXPORT_BASE_URL || '/api/local-region';
  const browserAssembly = match.resourceStatus !== 'staged' && assetBase && match.storage
    ? { assemblyName: genome.accession, defaultLocus, assetBase, regionExportBase, assets: browserAssets }
    : null;

  return (
    <main className="portal-page genome-detail-page">
      <section className="portal-shell detail-heading">
        <Link href="/genomes" className="back-link"><ArrowBackRoundedIcon fontSize="small" /> Genome catalog</Link>
        <div className="detail-title-row">
          <div><p className="portal-kicker">Assembly {genome.accession}</p><h1>{genome.organismName}</h1>{genome.strain && <p className="detail-strain">Strain {genome.strain}</p>}</div>
          <div className="release-stamp"><span>Release</span><strong>{releaseId}</strong></div>
        </div>
      </section>

      <section className="portal-shell detail-grid">
        <div className="detail-main">
          <section className="detail-section">
            <div className="detail-section-heading"><div><p className="portal-kicker">Interactive tracks</p><h2>Genome browser</h2></div><code>{defaultLocus}</code></div>
            {browserAssembly
              ? <><PortalBrowserPanel assembly={browserAssembly} /><p className="browser-evidence-note">The promoter track contains model-predicted peaks. NCBI annotation is shown as a separate track only when it is available for this assembly.</p></>
              : <div className="browser-unavailable"><strong>Genome files are being prepared</strong><p>The catalog metadata and feature counts are available. Reference and indexed track files will appear here after upload validation.</p></div>}
          </section>

        </div>

        <aside className="metadata-panel">
          <h2>Genome metadata</h2>
          <dl>
            <div><dt>Accession</dt><dd>{genome.accession}</dd></div>
            <div><dt>Genome source</dt><dd>{genome.genomeSource || 'Not reported'}</dd></div>
            <div><dt>Genome size</dt><dd>{formatNumber(genome.genomeSizeBp, ' bp')}</dd></div>
            <div><dt>GC content</dt><dd>{formatNumber(genome.gcContent, '%')}</dd></div>
            <div><dt>Contigs</dt><dd>{formatNumber(genome.contigCount)}</dd></div>
            <div><dt>Predicted promoters</dt><dd>{genome.predictedPromoterCount.toLocaleString()}</dd></div>
            <div><dt>NCBI annotation</dt><dd>{genome.annotationStatus === 'available' ? `${genome.annotationFeatureCount.toLocaleString()} ${browserAssembly ? 'usable' : 'cataloged'} features` : 'Not available'}</dd></div>
          </dl>
          <h3>Taxonomy</h3>
          <ol className="taxonomy-list">
            {[
              { rank: 'domain', value: genome.domain },
              { rank: 'phylum', value: genome.phylum },
              { rank: 'class', value: genome.className },
              { rank: 'order', value: genome.orderName },
              { rank: 'family', value: genome.family },
              { rank: 'genus', value: genome.genus },
            ].filter((entry): entry is { rank: string; value: string } => Boolean(entry.value))
              .map((entry) => <li key={entry.rank}>{entry.value}</li>)}
          </ol>
        </aside>
      </section>
    </main>
  );
}
