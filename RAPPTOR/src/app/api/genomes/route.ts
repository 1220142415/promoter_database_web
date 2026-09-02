import {
  GenomeCatalogUnavailableError,
} from '@/features/genomes/repository';
import { ExperimentalTssCatalogUnavailableError } from '@/features/genome-browser/experimental-tss-repository';
import { UnifiedGenomeCursorError, unifiedGenomeRepository } from '@/features/genome-browser/unified-genome-repository';
import { GenomeSearchQueryError, parseGenomeSearchParams } from '@/features/genomes/search-query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const query = parseGenomeSearchParams(searchParams);
    const result = await unifiedGenomeRepository.search(query);
    return Response.json(result, {
      headers: {
        'Cache-Control': Object.values(query.taxonomy).some(Boolean)
          ? 'no-store'
          : 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800',
      },
    });
  } catch (cause) {
    if (cause instanceof GenomeSearchQueryError || cause instanceof UnifiedGenomeCursorError) {
      return Response.json({ error: cause.message }, { status: 400 });
    }
    if (cause instanceof GenomeCatalogUnavailableError || cause instanceof ExperimentalTssCatalogUnavailableError) {
      return Response.json({ error: cause.message }, { status: 503 });
    }
    console.error('Genome catalog query failed.', cause);
    return Response.json({ error: 'Genome catalog query failed.' }, { status: 500 });
  }
}
