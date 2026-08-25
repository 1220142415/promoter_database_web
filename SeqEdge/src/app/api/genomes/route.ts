import {
  GenomeCatalogUnavailableError,
} from '@/lib/genome-catalog-repository';
import { ExperimentalTssCatalogUnavailableError } from '@/lib/experimental-tss-repository';
import { UnifiedGenomeCursorError, unifiedGenomeRepository } from '@/lib/unified-genome-repository';
import { GenomeSearchQueryError, parseGenomeSearchParams } from '@/lib/genome-search-query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const query = parseGenomeSearchParams(new URL(request.url).searchParams);
    const result = await unifiedGenomeRepository.search(query);
    return Response.json(result, {
      headers: {
        'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=300',
      },
    });
  } catch (cause) {
    if (cause instanceof GenomeSearchQueryError || cause instanceof UnifiedGenomeCursorError) {
      return Response.json({ error: cause.message }, { status: 400 });
    }
    if (cause instanceof GenomeCatalogUnavailableError || cause instanceof ExperimentalTssCatalogUnavailableError) {
      return Response.json({ error: cause.message }, { status: 503 });
    }
    return Response.json({ error: 'Genome catalog query failed.' }, { status: 500 });
  }
}
