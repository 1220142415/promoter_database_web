import type { Metadata } from 'next';
import DataObjectRoundedIcon from '@mui/icons-material/DataObjectRounded';
import MenuBookRoundedIcon from '@mui/icons-material/MenuBookRounded';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded';
import PortalGenomeExplorer from '@/features/genomes/components/genome-explorer';
import PortalReleaseState from '@/features/genomes/components/release-state';
import { DEFAULT_UNIFIED_GENOME_SEARCH_QUERY } from '@/features/genomes/search-query';
import { unifiedGenomeRepository } from '@/features/genome-browser/unified-genome-repository';
import { experimentalTssPublicEnabled } from '@/features/genome-browser/experimental-tss-public';
import type { UnifiedGenomeEvidenceFilter } from '@/types/unified-genome';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Genome catalog | RAPPTOR',
  description: 'Search and filter bacterial genome assemblies in the current RAPPTOR release.',
};

const EVIDENCE_FILTERS = new Set<UnifiedGenomeEvidenceFilter>(['all', 'predictions', 'experimental', 'both']);

export default async function GenomesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requestedEvidence = (await searchParams).evidence;
  const showExperimental = experimentalTssPublicEnabled();
  const evidence = showExperimental && typeof requestedEvidence === 'string' && EVIDENCE_FILTERS.has(requestedEvidence as UnifiedGenomeEvidenceFilter)
    ? requestedEvidence as UnifiedGenomeEvidenceFilter
    : 'all';
  let initialResult;
  try {
    initialResult = await unifiedGenomeRepository.search({ ...DEFAULT_UNIFIED_GENOME_SEARCH_QUERY, evidence });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'The genome catalog is unavailable.';
    return <PortalReleaseState message={message} />;
  }

  return (
    <main className="portal-page">
      <section className="portal-shell page-intro">
        <p className="portal-kicker">Prediction {initialResult.releases.predictionReleaseId}{showExperimental ? ` · Experimental ${initialResult.releases.experimentalReleaseId || 'Not published'}` : ''}</p>
        <h1>Genome catalog</h1>
        <p>{showExperimental
          ? 'Search assemblies once, then compare RAPPTOR promoter predictions with literature-derived experimental TSS observations when both are available for the same assembly.'
          : 'Search bacterial assemblies and inspect RAPPTOR promoter predictions with contextual NCBI annotations.'}</p>
      </section>
      <section className="portal-shell experimental-metrics" aria-label="Genome evidence statistics">
        <div><PublicRoundedIcon aria-hidden="true" /><span>Prediction genomes</span><strong>{initialResult.stats.predictionGenomes.toLocaleString()}</strong></div>
        {showExperimental ? <div><ScienceRoundedIcon aria-hidden="true" /><span>Experimental genomes</span><strong>{initialResult.stats.experimentalGenomes.toLocaleString()}</strong></div> : null}
        {showExperimental ? <div><DataObjectRoundedIcon aria-hidden="true" /><span>Both evidence types</span><strong>{initialResult.stats.bothGenomes.toLocaleString()}</strong></div> : null}
        {showExperimental ? <div><MenuBookRoundedIcon aria-hidden="true" /><span>Experimental observations</span><strong>{initialResult.stats.totalExperimentalObservations.toLocaleString()}</strong></div> : null}
      </section>
      <section className="portal-shell catalog-section">
        <PortalGenomeExplorer initialResult={initialResult} initialEvidence={evidence} showExperimental={showExperimental} />
      </section>
    </main>
  );
}
