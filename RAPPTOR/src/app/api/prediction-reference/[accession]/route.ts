import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ accession: string }>;
};

const MAX_COMPRESSED_REFERENCE_BYTES = 10 * 1024 * 1024;
const PREDICTION_REFERENCES: Record<string, { fileName: string; upstreamUrl: string }> = {
  'GCF_000005845.2': {
    fileName: 'GCF_000005845.2_ASM584v2_genomic.fna.gz',
    upstreamUrl: 'https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/005/845/GCF_000005845.2_ASM584v2/GCF_000005845.2_ASM584v2_genomic.fna.gz',
  },
};

async function serve(context: RouteContext, headOnly: boolean) {
  const { accession } = await context.params;
  const reference = PREDICTION_REFERENCES[accession];
  if (!reference) return NextResponse.json({ error: 'Unknown prediction reference.' }, { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetch(reference.upstreamUrl, {
      method: headOnly ? 'HEAD' : 'GET',
      headers: { Accept: 'application/gzip, application/octet-stream;q=0.9, */*;q=0.1' },
      redirect: 'follow',
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'Prediction reference could not be reached.' }, { status: 502 });
  }
  if (!upstream.ok) {
    return NextResponse.json({ error: 'Prediction reference is unavailable.' }, { status: upstream.status === 404 ? 404 : 502 });
  }

  const declaredLength = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && (declaredLength <= 0 || declaredLength > MAX_COMPRESSED_REFERENCE_BYTES)) {
    return NextResponse.json({ error: 'Prediction reference has an invalid size.' }, { status: 502 });
  }

  const headers = new Headers({
    'Cache-Control': 'public, max-age=86400, s-maxage=31536000, immutable',
    'Content-Disposition': `inline; filename="${reference.fileName}"`,
    'Content-Type': 'application/gzip',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const name of ['content-length', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(headOnly ? null : upstream.body, { status: 200, headers });
}

export function GET(_request: Request, context: RouteContext) {
  return serve(context, false);
}

export function HEAD(_request: Request, context: RouteContext) {
  return serve(context, true);
}
