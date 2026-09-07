import { REAL_PREDICTION_REFERENCE } from '@/features/prediction/reference-example';
import { loadPredictionReference } from '@/features/prediction/reference-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ accession: string }> };

async function serve(context: RouteContext, headOnly: boolean) {
  const { accession } = await context.params;
  if (accession !== REAL_PREDICTION_REFERENCE.accession) return Response.json({ error: 'Unknown prediction reference.' }, { status: 404 });
  try {
    const fasta = await loadPredictionReference();
    return new Response(headOnly ? null : fasta, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': String(new TextEncoder().encode(fasta).byteLength),
        'Content-Disposition': `inline; filename="${REAL_PREDICTION_REFERENCE.fileName}"`,
        'Cache-Control': 'public, max-age=86400, immutable',
        'ETag': `"${REAL_PREDICTION_REFERENCE.fastaSha256}"`,
        'X-Reference-SHA256': REAL_PREDICTION_REFERENCE.fastaSha256,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return Response.json({ error: 'The reference could not be loaded and verified. Retry the download.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

export function GET(_request: Request, context: RouteContext) { return serve(context, false); }
export function HEAD(_request: Request, context: RouteContext) { return serve(context, true); }
