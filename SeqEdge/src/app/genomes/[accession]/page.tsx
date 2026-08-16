import type { Metadata } from 'next';
import { isValidElement, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import PortalBrowserPanel from '@/components/portal-browser-panel';
import PortalOnDemandBrowserPanel from '@/components/portal-on-demand-browser-panel';
import { genomeCatalogRepository } from '@/lib/genome-catalog-repository';

function formatNumber(value: number | null, suffix = '') {
  return value === null ? 'Not reported' : `${value.toLocaleString()}${suffix}`;
}

type MetadataFact = {
  label: string;
  value: ReactNode;
  mono?: boolean;
};

function metadataValue(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return 'Not reported';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function hasMetadataValue(value: ReactNode) {
  if (value === null || value === undefined || value === '' || value === 'Not reported') return false;
  return !Array.isArray(value) || value.length > 0;
}

function MetadataMetric({ label, value, context }: { label: string; value: ReactNode; context: string }) {
  return (
    <div className="genome-metric">
      <span>{label}</span>
      <strong>{metadataValue(value)}</strong>
      <small>{context}</small>
    </div>
  );
}

function QualityBar({ label, value, hint, tone }: { label: string; value: number; hint: string; tone: 'teal' | 'gold' }) {
  const fill = Math.max(0, Math.min(100, value));
  return (
    <div className={`genome-quality-measure genome-quality-${tone}`}>
      <div><span>{label}</span><strong>{value.toLocaleString()}%</strong></div>
      <div className="genome-quality-track" aria-hidden="true"><span style={{ width: `${fill}%` } as CSSProperties} /></div>
      <small>{hint}</small>
    </div>
  );
}

function MetadataGroup({ title, description, facts, open = false }: { title: string; description: string; facts: MetadataFact[]; open?: boolean }) {
  const visibleFacts = facts.filter((fact) => hasMetadataValue(fact.value));

  return (
    <details className="genome-metadata-group" open={open}>
      <summary><span>{title}</span><small>{description}</small></summary>
      <dl>
        {visibleFacts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className={fact.mono ? 'metadata-mono' : undefined}>{isValidElement(fact.value) ? fact.value : metadataValue(fact.value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
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
  const { releaseId, assetBase, genome, details } = match;
  const defaultLocus = genome.defaultLocus || `${genome.primarySequence || genome.accession}:1-10000`;
  const browserAssets = genome.annotationStatus === 'available'
    ? genome.assets
    : { ...genome.assets, ncbiAnnotations: null, ncbiAnnotationsIndex: null };
  const regionExportBase = process.env.NEXT_PUBLIC_REGION_EXPORT_BASE_URL
    || (process.env.NODE_ENV === 'production' ? undefined : '/api/local-region');
  const browserAssembly = match.resourceStatus !== 'staged' && assetBase && match.storage
    ? { assemblyName: genome.accession, defaultLocus, assetBase, regionExportBase, assets: browserAssets }
    : null;
  const qualityMeasures = [
    genome.completeness === null ? null : { label: 'Completeness', value: genome.completeness, hint: 'Higher is better', tone: 'teal' as const },
    details?.codingDensity === null || details?.codingDensity === undefined ? null : { label: 'Coding density', value: details.codingDensity, hint: 'Share of coding sequence', tone: 'teal' as const },
    genome.contamination === null ? null : { label: 'Contamination', value: genome.contamination, hint: 'Lower is better', tone: 'gold' as const },
  ].filter((measure) => measure !== null);

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
              : match.plannedAssets
                ? <><PortalOnDemandBrowserPanel accession={genome.accession} releaseId={releaseId} plannedAssets={match.plannedAssets} /><p className="browser-evidence-note">Unindexed files are prepared only for this genome and cached locally by the browser.</p></>
              : <div className="browser-unavailable"><strong>Genome files are being prepared</strong><p>The catalog metadata and feature counts are available. Reference and indexed track files will appear here after upload validation.</p></div>}
          </section>
        </div>

        <section className="genome-metadata-section" aria-labelledby="genome-metadata-heading">
          <div className="genome-metadata-heading">
            <p className="portal-kicker">Catalog record</p>
            <h2 id="genome-metadata-heading">Genome summary</h2>
            <p>Key biological and quality signals first. Expand a section only when you need the underlying catalog details.</p>
          </div>

          <div className="genome-metrics-grid" aria-label="Genome key metrics">
            <MetadataMetric label="Genome size" value={formatNumber(genome.genomeSizeBp, ' bp')} context="Assembly span" />
            <MetadataMetric label="GC content" value={formatNumber(genome.gcContent, '%')} context="Base composition" />
            <MetadataMetric label="Contigs" value={formatNumber(genome.contigCount)} context="Assembly continuity" />
            <MetadataMetric label="Completeness" value={formatNumber(genome.completeness, '%')} context="Quality estimate" />
            <MetadataMetric label="Contamination" value={formatNumber(genome.contamination, '%')} context="Quality estimate" />
            <MetadataMetric label="Promoters" value={formatNumber(genome.predictedPromoterCount)} context="Model predictions" />
          </div>

          {qualityMeasures.length > 0 && (
            <section className="genome-quality-overview" aria-labelledby="quality-overview-heading">
              <div><p className="portal-kicker">Quality signals</p><h3 id="quality-overview-heading">Assembly quality at a glance</h3></div>
              <div className="genome-quality-grid">
                {qualityMeasures.map((measure) => <QualityBar key={measure.label} {...measure} />)}
              </div>
            </section>
          )}

          <div className="genome-metadata-groups">
            <MetadataGroup title="Assembly overview" description="Identifiers and source" open facts={[
              { label: 'Accession', value: genome.accession, mono: true },
              { label: 'NCBI organism name', value: details?.ncbiOrganismName },
              { label: 'NCBI Tax ID', value: details?.ncbiTaxId, mono: true },
              { label: 'Genome source', value: genome.genomeSource },
              { label: 'Assembly level', value: genome.assemblyLevel },
              { label: 'Assembly name', value: details?.assemblyName },
              { label: 'RefSeq assembly accession', value: details?.refseqAssemblyAccession, mono: true },
              {
                label: 'NCBI record',
                value: details?.assemblySourceUrl
                  ? <a href={details.assemblySourceUrl} target="_blank" rel="noreferrer">Open NCBI record</a>
                  : null,
              },
            ]} />

            <MetadataGroup title="Taxonomy" description="GTDB lineage" facts={[
              { label: 'Domain', value: genome.domain },
              { label: 'Phylum', value: genome.phylum },
              { label: 'Class', value: genome.className },
              { label: 'Order', value: genome.orderName },
              { label: 'Family', value: genome.family },
              { label: 'Genus', value: genome.genus },
              { label: 'Species', value: details?.species },
              { label: 'Taxonomy source', value: details?.taxonomySource },
            ]} />

            <MetadataGroup title="Quality and annotation" description="Continuity and features" facts={[
              { label: 'Contig N50', value: formatNumber(details?.contigN50 ?? null, ' bp') },
              { label: 'Longest contig', value: formatNumber(details?.longestContigBp ?? null, ' bp') },
              { label: 'Protein count', value: formatNumber(details?.proteinCount ?? null) },
              { label: 'tRNA count', value: formatNumber(details?.trnaCount ?? null) },
              { label: 'MIMAG quality', value: details?.mimagQuality },
              { label: 'Portal status', value: genome.annotationStatus },
              { label: 'Feature count', value: genome.annotationFeatureCount },
              { label: 'Experimental TSS count', value: genome.experimentalTssCount },
            ]} />

            <MetadataGroup title="Analysis and release" description="Methods and provenance" facts={[
              { label: 'Prediction method', value: details?.promoter.sourceId },
              { label: 'Model version', value: details?.promoter.sourceVersion },
              { label: 'Score threshold', value: metadataValue(details?.promoter.configuration?.threshold) },
              { label: 'Prediction generated at', value: details?.promoter.generatedAt },
              { label: 'Annotation source', value: details?.annotation.sourceId },
              { label: 'Annotation version', value: details?.annotation.sourceVersion },
              { label: 'Annotation generated at', value: details?.annotation.generatedAt },
              { label: 'SeqEdge release', value: releaseId, mono: true },
              { label: 'GTDB taxonomy release', value: details?.release.sourceReleaseId, mono: true },
              { label: 'Release date', value: details?.release.releaseDate },
              { label: 'Publication status', value: details?.release.publicationStatus },
              {
                label: 'Dataset repository',
                value: details?.release.hfRepository
                  ? <a href={`https://huggingface.co/datasets/${details.release.hfRepository}`} target="_blank" rel="noreferrer">Open Hugging Face dataset</a>
                  : null,
              },
            ]} />
          </div>
        </section>
      </section>
    </main>
  );
}
