import { findNcbiReference, ncbiErrorResponse } from '@/features/prediction/ncbi-reference';
import { resolvePredictionReferenceSource } from '@/features/prediction/reference-source';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const accession = new URL(request.url).searchParams.get('accession')?.trim().toUpperCase();
    if (accession && await resolvePredictionReferenceSource(accession)) {
      return Response.json({ items: [{ accession, organismName: `Published reference ${accession}`, source: 'huggingface' }] }, {
        headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' },
      });
    }
    const reference = await findNcbiReference(accession);
    // Deliberately omit all download URLs; the browser receives metadata only.
    return Response.json({ items: reference ? [{ accession: reference.accession, organismName: reference.organismName, source: reference.source }] : [] }, {
      headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' },
    });
  } catch (cause) { return ncbiErrorResponse(cause); }
}
