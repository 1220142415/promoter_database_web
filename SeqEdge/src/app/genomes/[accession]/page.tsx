import type { Metadata } from 'next';
import { isValidElement, type ReactNode } from 'react';
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

function humanizeMetadataKey(value: string) {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

function recordFacts(prefix: string, record: Record<string, unknown> | undefined): MetadataFact[] {
  if (!record || Object.keys(record).length === 0) return [{ label: `${prefix} details`, value: 'Not reported' }];
  return Object.entries(record).map(([key, value]) => ({
    label: `${prefix}: ${humanizeMetadataKey(key)}`,
    value: metadataValue(value),
  }));
}

function MetadataGroup({ title, facts }: { title: string; facts: MetadataFact[] }) {
  return (
    <section className="genome-metadata-group">
      <h3>{title}</h3>
      <dl>
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className={fact.mono ? 'metadata-mono' : undefined}>{isValidElement(fact.value) ? fact.value : metadataValue(fact.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
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
            <h2 id="genome-metadata-heading">Genome metadata</h2>
            <p>Assembly, quality, taxonomy, feature provenance and release fields recorded in the SeqEdge catalog.</p>
          </div>
          <div className="genome-metadata-grid">
            <MetadataGroup title="Identity and assembly" facts={[
              { label: 'Accession', value: genome.accession, mono: true },
              { label: 'Organism name', value: genome.organismName },
              { label: 'NCBI organism name', value: details?.ncbiOrganismName },
              { label: 'Strain', value: genome.strain },
              { label: 'NCBI Tax ID', value: details?.ncbiTaxId, mono: true },
              { label: 'Genome source', value: genome.genomeSource },
              { label: 'Assembly level', value: genome.assemblyLevel },
              { label: 'Assembly name', value: details?.assemblyName },
              { label: 'GenBank assembly accession', value: details?.genbankAssemblyAccession, mono: true },
              { label: 'RefSeq assembly accession', value: details?.refseqAssemblyAccession, mono: true },
              { label: 'Primary sequence', value: genome.primarySequence, mono: true },
              { label: 'Default locus', value: defaultLocus, mono: true },
              {
                label: 'Assembly source record',
                value: details?.assemblySourceUrl
                  ? <a href={details.assemblySourceUrl} target="_blank" rel="noreferrer">Open NCBI record</a>
                  : null,
              },
            ]} />

            <MetadataGroup title="Taxonomy" facts={[
              { label: 'Domain', value: genome.domain },
              { label: 'Phylum', value: genome.phylum },
              { label: 'Class', value: genome.className },
              { label: 'Order', value: genome.orderName },
              { label: 'Family', value: genome.family },
              { label: 'Genus', value: genome.genus },
              { label: 'Species', value: details?.species },
              { label: 'Taxonomy source', value: details?.taxonomySource },
              { label: 'GTDB representative', value: details?.gtdbRepresentative },
              { label: 'GTDB genome representative', value: details?.gtdbGenomeRepresentative, mono: true },
              { label: 'Full taxonomy', value: details?.taxonomyRaw },
            ]} />

            <MetadataGroup title="Assembly statistics and quality" facts={[
              { label: 'Genome size', value: formatNumber(genome.genomeSizeBp, ' bp') },
              { label: 'GC content', value: formatNumber(genome.gcContent, '%') },
              { label: 'Contigs', value: formatNumber(genome.contigCount) },
              { label: 'Contig N50', value: formatNumber(details?.contigN50 ?? null, ' bp') },
              { label: 'Longest contig', value: formatNumber(details?.longestContigBp ?? null, ' bp') },
              { label: 'Ambiguous bases', value: formatNumber(details?.ambiguousBases ?? null, ' bp') },
              { label: 'Coding density', value: formatNumber(details?.codingDensity ?? null, '%') },
              { label: 'Protein count', value: formatNumber(details?.proteinCount ?? null) },
              { label: 'tRNA count', value: formatNumber(details?.trnaCount ?? null) },
              { label: 'SSU rRNA count', value: formatNumber(details?.ssuRrnaCount ?? null) },
              { label: 'LSU 23S rRNA count', value: formatNumber(details?.lsu23sRrnaCount ?? null) },
              { label: 'Completeness', value: formatNumber(genome.completeness, '%') },
              { label: 'Contamination', value: formatNumber(genome.contamination, '%') },
              { label: 'Strain heterogeneity', value: formatNumber(details?.strainHeterogeneity ?? null, '%') },
              { label: 'MIMAG quality', value: details?.mimagQuality },
            ]} />

            <MetadataGroup title="Promoter prediction" facts={[
              { label: 'Predicted promoters', value: genome.predictedPromoterCount },
              { label: 'Catalog status', value: details?.promoter.status },
              { label: 'Definition ID', value: details?.promoter.definitionId, mono: true },
              { label: 'Evidence type', value: details?.promoter.evidenceType },
              { label: 'Count unit', value: details?.promoter.countUnit },
              { label: 'Prediction method', value: details?.promoter.sourceId },
              { label: 'Model version', value: details?.promoter.sourceVersion },
              { label: 'Generated at', value: details?.promoter.generatedAt },
              ...recordFacts('Configuration', details?.promoter.configuration),
              ...recordFacts('Provenance', details?.promoter.provenance),
              ...recordFacts('Feature counts', details?.promoter.detailCounts),
              { label: 'Data path', value: details?.promoter.dataPath, mono: true },
              { label: 'Index path', value: details?.promoter.indexPath, mono: true },
              { label: 'Data SHA-256', value: details?.promoter.dataSha256, mono: true },
              { label: 'Index SHA-256', value: details?.promoter.indexSha256, mono: true },
            ]} />

            <MetadataGroup title="NCBI genome annotation" facts={[
              { label: 'Portal status', value: genome.annotationStatus },
              { label: 'Feature count', value: genome.annotationFeatureCount },
              { label: 'Circular-origin split features', value: genome.annotationCircularOriginSplitCount ?? 0 },
              { label: 'Experimental TSS count', value: genome.experimentalTssCount },
              { label: 'Has experimental TSS', value: genome.hasExperimentalTss },
              { label: 'Catalog status', value: details?.annotation.status },
              { label: 'Definition ID', value: details?.annotation.definitionId, mono: true },
              { label: 'Evidence type', value: details?.annotation.evidenceType },
              { label: 'Count unit', value: details?.annotation.countUnit },
              { label: 'Annotation source', value: details?.annotation.sourceId },
              { label: 'Annotation version', value: details?.annotation.sourceVersion },
              { label: 'Generated at', value: details?.annotation.generatedAt },
              ...recordFacts('Configuration', details?.annotation.configuration),
              ...recordFacts('Provenance', details?.annotation.provenance),
              ...recordFacts('Feature counts', details?.annotation.detailCounts),
              { label: 'Data path', value: details?.annotation.dataPath, mono: true },
              { label: 'Index path', value: details?.annotation.indexPath, mono: true },
              { label: 'Data SHA-256', value: details?.annotation.dataSha256, mono: true },
              { label: 'Index SHA-256', value: details?.annotation.indexSha256, mono: true },
            ]} />

            <MetadataGroup title="Release and storage" facts={[
              { label: 'SeqEdge release', value: releaseId, mono: true },
              { label: 'Source release', value: details?.release.sourceReleaseId, mono: true },
              { label: 'Dataset version', value: details?.release.datasetVersion, mono: true },
              { label: 'Metadata schema version', value: details?.release.metadataSchemaVersion, mono: true },
              { label: 'Release date', value: details?.release.releaseDate },
              { label: 'Generated at', value: details?.release.generatedAt },
              { label: 'Publication status', value: details?.release.publicationStatus },
              { label: 'Resource status', value: match.resourceStatus },
              { label: 'Storage layout', value: match.storage?.layout || details?.release.storageLayout },
              { label: 'Logical object prefix', value: match.storage?.logicalObjectPrefix, mono: true },
              { label: 'Storage base URL', value: match.storage?.baseUrl || assetBase, mono: true },
              { label: 'Hugging Face repository', value: details?.release.hfRepository, mono: true },
              { label: 'Hugging Face revision', value: details?.release.hfRevision, mono: true },
              { label: 'Release asset base URL', value: details?.release.releaseAssetBaseUrl, mono: true },
              { label: 'Manifest index path', value: details?.release.manifestIndexPath, mono: true },
              { label: 'Reference SHA-256', value: details?.referenceSha256, mono: true },
              { label: 'Reference FASTA path', value: genome.assets.fasta, mono: true },
              { label: 'Reference FAI path', value: genome.assets.fastaFai, mono: true },
              { label: 'Reference GZI path', value: genome.assets.fastaGzi, mono: true },
              { label: 'Genome metadata path', value: genome.assets.metadata, mono: true },
              { label: 'Planned upload batch', value: match.plannedAssets?.batch, mono: true },
            ]} />
          </div>
        </section>
      </section>
    </main>
  );
}
