import { findNcbiReference, ncbiErrorResponse } from '@/features/prediction/ncbi-reference';
import { UPLOAD_PREDICTION_REFERENCE } from '@/features/prediction/reference-example';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const accession = new URL(request.url).searchParams.get('accession')?.trim().toUpperCase();
    if (accession === UPLOAD_PREDICTION_REFERENCE.accession) {
      return Response.json({ items: [{ accession, organismName: UPLOAD_PREDICTION_REFERENCE.organism, source: 'ncbi' }] }, {
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
