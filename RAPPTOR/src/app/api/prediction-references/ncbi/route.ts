import { findNcbiReference, ncbiErrorResponse } from '@/features/prediction/ncbi-reference';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const reference = await findNcbiReference(new URL(request.url).searchParams.get('accession'));
    // Deliberately omit all download URLs; the browser receives metadata only.
    return Response.json({ items: reference ? [{ accession: reference.accession, organismName: reference.organismName, source: reference.source }] : [] }, {
      headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' },
    });
  } catch (cause) { return ncbiErrorResponse(cause); }
}
