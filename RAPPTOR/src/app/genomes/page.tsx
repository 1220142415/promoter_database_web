import type { Metadata } from 'next';
import GenomeExplorer from '@/features/genomes/components/genome-explorer';
import ReleaseState from '@/features/genomes/components/release-state';
import { genomeCatalogRepository } from '@/features/genomes/repository';
import { DEFAULT_GENOME_SEARCH_QUERY } from '@/features/genomes/search-query';

export const metadata: Metadata = {
  title: 'Genome catalog | RAPPTOR',
  description: 'Search and filter bacterial genome assemblies in the current RAPPTOR release.',
};

export default async function GenomesPage() {
  let initialResult;
  try {
    initialResult = await genomeCatalogRepository.search(DEFAULT_GENOME_SEARCH_QUERY);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'The genome catalog is unavailable.';
    return <ReleaseState message={message} />;
  }

  return (
    <main className="portal-page">
      <section className="portal-shell page-intro">
        <p className="portal-kicker">Release {initialResult.releaseId}</p>
        <h1>Genome catalog</h1>
        <p>Search assemblies by accession, organism and taxonomy, then open a genome to inspect its release metadata, promoter track and downloadable files.</p>
      </section>
      <section className="portal-shell catalog-section">
        <GenomeExplorer initialResult={initialResult} />
      </section>
    </main>
  );
}
