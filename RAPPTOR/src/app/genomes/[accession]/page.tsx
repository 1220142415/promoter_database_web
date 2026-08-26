import type { Metadata } from 'next';
import { isValidElement, type ReactNode } from 'react';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import GenomeFileStatus from '@/features/genome-browser/components/genome-file-status';
import PortalOnDemandBrowserPanel from '@/features/genome-browser/components/portal-on-demand-browser-panel';
import UnifiedBrowserPanel from '@/features/genome-browser/components/unified-browser-panel';
import { unifiedGenomeRepository } from '@/features/genome-browser/unified-genome-repository';
import type { ExperimentalTssGenome } from '@/types/experimental-tss';
import type { GenomeCatalogMatch } from '@/features/genomes/types';
import type { JBrowseReleaseAssembly } from '@/types/release';

const SHARE_PARAMETERS = ['view', 'ref', 'center', 'zoom', 'rev', 'tracks'] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type MetadataFact = { label: string; value: ReactNode; mono?: boolean };

export const dynamic = 'force-dynamic';

const findGenome = cache((accession: string, assemblySource?: 'prediction' | 'experimental') => unifiedGenomeRepository.getByAccession(accession, assemblySource));

function safeShareQuery(values: Awaited<SearchParams>) {
  const query = new URLSearchParams();
  if (values.assembly === 'prediction' || values.assembly === 'experimental') query.set('assembly', values.assembly);
  for (const name of SHARE_PARAMETERS) {
    const value = values[name];
    if (typeof value === 'string') query.set(name, value);
  }
  return query.toString();
}

function formatNumber(value: number | null | undefined, suffix = '') {
  return value === null || value === undefined ? 'Not reported' : `${value.toLocaleString()}${suffix}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

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

function MetadataMetric({ label, value }: { label: string; value: ReactNode }) {
  return <div className="genome-metric"><span>{label}</span><strong>{metadataValue(value)}</strong></div>;
}

function MetadataGroup({ title, facts, open = false }: { title: string; facts: MetadataFact[]; open?: boolean }) {
  const visibleFacts = facts.filter((fact) => hasMetadataValue(fact.value));
  if (!visibleFacts.length) return null;
  return (
    <details className="genome-metadata-group" open={open}>
      <summary><span>{title}</span></summary>
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

function predictionAssembly(match: GenomeCatalogMatch | null): JBrowseReleaseAssembly | null {
  if (!match) return null;
  const { assetBase, genome } = match;
  if (match.resourceStatus === 'staged' || !assetBase || !match.storage) return null;
  const defaultLocus = genome.defaultLocus || `${genome.primarySequence || genome.accession}:1-10000`;
  const assets = genome.annotationStatus === 'available'
    ? genome.assets
    : { ...genome.assets, ncbiAnnotations: null, ncbiAnnotationsIndex: null };
  const regionExportBase = process.env.NEXT_PUBLIC_REGION_EXPORT_BASE_URL
    || (process.env.NODE_ENV === 'production' ? undefined : '/api/local-region');
  return {
    assemblyName: genome.accession,
    defaultLocus,
    assetBase,
    regionExportBase,
    assets,
    adapterMode: match.adapterMode,
  };
}

function assetUrl(base: string, path: string, download = false) {
  return `${base.replace(/\/$/, '')}/${path}${download ? '?download=1' : ''}`;
}

function ExperimentalStudies({ genome }: { genome: ExperimentalTssGenome }) {
  return (
    <section className="experimental-download-section" aria-labelledby="experimental-evidence-heading">
      <div className="experimental-section-heading">
        <div><p className="portal-kicker">Published observations</p><h2 id="experimental-evidence-heading">Experimental TSS studies</h2></div>
        <p>{genome.studies.length} independent study {genome.studies.length === 1 ? 'track' : 'tracks'} · {genome.studies.reduce((sum, study) => sum + study.recordCount, 0).toLocaleString()} raw observations.</p>
      </div>
      <div className="experimental-reference-downloads" aria-label="Experimental assembly downloads">
        <a href={assetUrl(genome.assetBase, genome.assets.fasta, true)} download><span><strong>Reference sequence</strong><small>{genome.assets.fastaFai && genome.assets.fastaGzi ? 'BGZF FASTA' : 'FASTA'}</small></span><DownloadRoundedIcon aria-hidden="true" /></a>
        {genome.assets.ncbiAnnotations ? <a href={assetUrl(genome.assetBase, genome.assets.ncbiAnnotations, true)} download><span><strong>NCBI annotation</strong><small>Indexed GFF3</small></span><DownloadRoundedIcon aria-hidden="true" /></a> : null}
      </div>
      <div className="experimental-study-details">
        {genome.studies.map((study) => (
          <article key={study.studyId} id={study.studyId}>
            <div className="experimental-study-detail-heading">
              <div><p className="portal-kicker">{study.year} · PMID {study.pmid}</p><h3>{study.publication.title || `Experimental TSS study ${study.pmid}`}</h3></div>
              <strong>{study.recordCount.toLocaleString()} observations</strong>
            </div>
            <p>{study.publication.authors.length ? study.publication.authors.join('; ') : 'Authors unavailable'}{study.publication.journal ? ` · ${study.publication.journal}` : ''}</p>
            <div className="experimental-study-links">
              <a href={`https://pubmed.ncbi.nlm.nih.gov/${study.pmid}/`} target="_blank" rel="noreferrer">PubMed record</a>
              {study.publication.doi ? <a href={`https://doi.org/${study.publication.doi.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer">DOI</a> : null}
              <a href={assetUrl(genome.assetBase, study.assets.rawBed, true)} download>Original BED</a>
              <a href={assetUrl(genome.assetBase, study.assets.data, true)} download>Normalized GFF3</a>
            </div>
            <dl>
              <div><dt>Study ID</dt><dd><code>{study.studyId}</code></dd></div>
              {study.sourceFile ? <div><dt>Source file</dt><dd><code>{study.sourceFile}</code></dd></div> : null}
              {study.sourceSha256 ? <div><dt>Source SHA-256</dt><dd><code>{study.sourceSha256}</code></dd></div> : null}
              {study.datasetRow !== null ? <div><dt>Manifest row</dt><dd>{study.datasetRow.toLocaleString()}</dd></div> : null}
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ accession: string }> }): Promise<Metadata> {
  const { accession } = await params;
  const match = await findGenome(accession);
  const organism = match?.prediction?.genome.organismName || match?.experimental?.organismName;
  return match && organism
    ? { title: `${match.canonicalAccession} | RAPPTOR`, description: `${organism} genome predictions and experimental evidence.` }
    : { title: 'Genome not found | RAPPTOR' };
}

export default async function GenomeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ accession: string }>;
  searchParams?: SearchParams;
}) {
  const [{ accession }, queryValues] = await Promise.all([
    params,
    searchParams || Promise.resolve({} as Record<string, string | string[] | undefined>),
  ]);
  const assemblySource = queryValues.assembly === 'prediction' || queryValues.assembly === 'experimental'
    ? queryValues.assembly
    : undefined;
  const match = await findGenome(accession, assemblySource);
  if (!match) notFound();
  if (accession !== match.canonicalAccession) {
    if (match.assemblyCompatibility === 'mismatch' && match.evidenceState === 'experimental_only') {
      queryValues.assembly = 'experimental';
    }
    const query = safeShareQuery(queryValues);
    const destination = `/genomes/${encodeURIComponent(match.canonicalAccession)}`;
    permanentRedirect(query ? `${destination}?${query}` : destination);
  }

  const prediction = match.prediction;
  const experimental = match.experimental;
  const genome = prediction?.genome;
  const details = prediction?.details;
  const organismName = genome?.organismName || experimental!.organismName;
  const strain = genome?.strain || experimental?.strain;
  const browserPrediction = predictionAssembly(prediction);
  const browserExperimental = experimental && (!prediction || match.overlayAllowed === true) ? experimental : null;
  const experimentalObservations = experimental?.studies.reduce((sum, study) => sum + study.recordCount, 0) || 0;
  const promoterDensityPerMb = genome?.genomeSizeBp && genome.genomeSizeBp > 0
    ? genome.predictedPromoterCount * 1_000_000 / genome.genomeSizeBp
    : null;

  return (
    <main className="portal-page genome-detail-page">
      <section className="portal-shell detail-grid">
        <div className="detail-main">
          <section className="detail-section genome-browser-section">
            <header className="genome-browser-header">
              <Link href="/genomes" className="back-link"><ArrowBackRoundedIcon fontSize="small" /> Genome catalog</Link>
              <div className="detail-title-row">
                <div>
                  <p className="portal-kicker">Assembly {match.canonicalAccession}</p>
                  <h1>{organismName}</h1>
                  {strain ? <p className="detail-strain">Strain {strain}</p> : null}
                  <p className="detail-strain">
                    {prediction ? <span className="evidence-available">RAPPTOR predictions</span> : null}
                    {prediction && experimental ? ' · ' : null}
                    {experimental ? <span className="evidence-available">Experimental TSS</span> : null}
                  </p>
                </div>
                <div className="release-stamp"><span>Evidence releases</span><strong>{prediction ? match.releases.predictionReleaseId : 'No prediction'} · {experimental ? match.releases.experimentalReleaseId : 'No experimental'}</strong></div>
              </div>
            </header>

            {experimental ? (
              <div className="experimental-boundary-note" role="note">
                <strong>{prediction ? 'Predictions and experimental observations' : 'Experimental TSS only'}</strong>
                <p>{prediction
                  ? 'RAPPTOR promoter predictions and published 1 bp TSS observations are shown together as distinct evidence tracks; observations are not counted as model validation.'
                  : 'This assembly is not included in the active prediction release. Each flag is an original published 1 bp TSS observation.'}</p>
              </div>
            ) : null}

            {browserPrediction || browserExperimental
              ? <>
                  <GenomeFileStatus states={{
                    reference: 'available',
                    promoters: browserPrediction ? 'available' : prediction ? 'preparing' : 'unavailable',
                    annotation: (browserPrediction?.assets.ncbiAnnotations || browserExperimental?.assets.ncbiAnnotations) ? 'available' : 'unavailable',
                  }} />
                  <UnifiedBrowserPanel prediction={browserPrediction} experimental={browserExperimental} />
                </>
              : prediction?.plannedAssets
                ? <PortalOnDemandBrowserPanel accession={genome!.accession} releaseId={prediction.releaseId} plannedAssets={prediction.plannedAssets} />
                : <div className="browser-unavailable"><strong>Genome files are being prepared</strong><p>Genome metadata and feature counts are available. Indexed browser tracks will appear after upload validation.</p></div>}
          </section>
        </div>

        <section className="genome-metadata-section" aria-labelledby="genome-metadata-heading">
          <div className="genome-metadata-heading"><h2 id="genome-metadata-heading">Genome summary</h2></div>
          <div className="genome-metrics-grid" aria-label="Genome key metrics">
            <MetadataMetric label="Genome size" value={formatNumber(genome?.genomeSizeBp ?? experimental?.genomeSizeBp, ' bp')} />
            <MetadataMetric label="GC content" value={formatNumber(genome?.gcContent, '%')} />
            <MetadataMetric label="Contigs" value={formatNumber(genome?.contigCount ?? experimental?.contigCount)} />
            <MetadataMetric label="Completeness" value={formatNumber(genome?.completeness, '%')} />
            <MetadataMetric label="Predicted promoters" value={prediction ? formatNumber(genome?.predictedPromoterCount) : 'Not in active release'} />
            <MetadataMetric label="NCBI annotation features" value={formatNumber(genome?.annotationFeatureCount)} />
            <MetadataMetric label="Promoter density" value={promoterDensityPerMb === null ? null : `${promoterDensityPerMb.toLocaleString(undefined, { maximumFractionDigits: 1 })} / Mb`} />
            <MetadataMetric label="Experimental studies" value={experimental ? experimental.studies.length : 0} />
            <MetadataMetric label="Experimental TSS" value={experimental ? experimentalObservations : 0} />
          </div>

          <div className="genome-metadata-groups">
            <MetadataGroup title="Assembly overview" open facts={[
              { label: 'Canonical accession', value: match.canonicalAccession, mono: true },
              { label: 'Other accessions', value: match.aliases.filter((alias) => alias !== match.canonicalAccession).join(', ') || null, mono: true },
              { label: 'Assembly name', value: details?.assemblyName || experimental?.assemblyName },
              { label: 'GenBank accession', value: details?.genbankAssemblyAccession || experimental?.genbankAssemblyAccession, mono: true },
              { label: 'RefSeq accession', value: details?.refseqAssemblyAccession || experimental?.accession, mono: true },
              { label: 'NCBI organism name', value: details?.ncbiOrganismName },
              { label: 'Assembly level', value: genome?.assemblyLevel },
              { label: 'NCBI annotation', value: genome?.annotationStatus },
              { label: 'NCBI record', value: details?.assemblySourceUrl ? <a href={details.assemblySourceUrl} target="_blank" rel="noreferrer">Open NCBI record</a> : null },
            ]} />
            <MetadataGroup title="Taxonomy" facts={[
              { label: 'Domain', value: genome?.domain },
              { label: 'Phylum', value: genome?.phylum },
              { label: 'Class', value: genome?.className },
              { label: 'Order', value: genome?.orderName },
              { label: 'Family', value: genome?.family },
              { label: 'Genus', value: genome?.genus },
              { label: 'Species', value: details?.species },
            ]} />
            <MetadataGroup title="Prediction release" facts={[
              { label: 'Prediction model', value: details?.promoter.sourceId },
              { label: 'Prediction generated at', value: formatDate(details?.promoter.generatedAt) },
              { label: 'Taxonomy source', value: details?.taxonomySource },
              { label: 'RAPPTOR prediction release', value: prediction?.releaseId, mono: true },
              { label: 'Prediction availability', value: prediction ? 'Available' : 'Not included in the active prediction release' },
              { label: 'Dataset', value: details?.release.hfRepository ? <a href={`https://huggingface.co/datasets/${details.release.hfRepository}`} target="_blank" rel="noreferrer">Open Hugging Face dataset</a> : null },
            ]} />
            <MetadataGroup title="Experimental release" facts={[
              { label: 'Experimental release', value: experimental?.releaseId, mono: true },
              { label: 'Study tracks', value: experimental?.studies.length },
              { label: 'Raw observations', value: experimental ? experimentalObservations : null },
              { label: 'Evidence type', value: experimental ? 'Experimental TSS' : null },
            ]} />
          </div>
        </section>

        {experimental ? <ExperimentalStudies genome={experimental} /> : null}
      </section>
    </main>
  );
}
