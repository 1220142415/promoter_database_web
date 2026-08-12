import { NextResponse } from 'next/server';
import { genomeCatalogRepository } from '@/lib/genome-catalog-repository';
import { normalizeDownloadFilename } from '@/lib/track-download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACCESSION_PATTERN = /^GC[AF]_\d{9}\.\d+$/;
const ALLOWED_FILES = new Set([
  'reference.fa.gz',
  'reference.fa.gz.fai',
  'reference.fa.gz.gzi',
  'predicted-promoters.gff3.gz',
  'predicted-promoters.gff3.gz.tbi',
  'ncbi-annotations.gff3.gz',
  'ncbi-annotations.gff3.gz.tbi',
  'metadata.json',
]);

type RouteContext = {
  params: Promise<{ accession: string; file: string }>;
};

function pilotAccessions() {
  return new Set((process.env.HF_PILOT_ACCESSIONS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

function configuredIndividualUpstream(accession: string, file: string) {
  const base = (process.env.HF_STORAGE_BASE_URL || process.env.HF_PILOT_STORAGE_BASE_URL)?.replace(/\/+$/, '');
  return base ? `${base}/${accession}/${file}` : null;
}

function individualUpstream(storage: Extract<NonNullable<Awaited<ReturnType<typeof genomeCatalogRepository.getByAccession>>>['storage'], { layout: 'individual-v1' }>, accession: string, file: string) {
  const base = storage.baseUrl?.replace(/\/+$/, '');
  return base ? `${base}/${storage.logicalObjectPrefix}/${file}` : configuredIndividualUpstream(accession, file);
}

async function serve(request: Request, context: RouteContext, headOnly: boolean) {
  const { accession, file } = await context.params;
  if (!ACCESSION_PATTERN.test(accession) || !ALLOWED_FILES.has(file)) {
    return NextResponse.json({ error: 'Unknown remote release asset.' }, { status: 404 });
  }
  const match = await genomeCatalogRepository.getByAccession(accession);
  if (!match) return NextResponse.json({ error: 'Unknown remote release asset.' }, { status: 404 });
  const completeRelease = Boolean(process.env.HF_STORAGE_BASE_URL || process.env.NODE_ENV === 'production' || process.env.SEQEDGE_CATALOG_BACKEND === 'd1');
  if (!completeRelease && !pilotAccessions().has(accession)) return NextResponse.json({ error: 'Unknown remote release asset.' }, { status: 404 });
  if (match.storage.layout === 'packed-v1') return servePacked(request, match.storage, file, headOnly);
  const upstream = individualUpstream(match.storage, accession, file);
  if (!upstream) return NextResponse.json({ error: 'Remote storage is not configured.' }, { status: 503 });

  return serveIndividual(request, upstream, file, headOnly);
}

async function fetchUpstream(url: string, method: 'GET' | 'HEAD', range?: string) {
  const headers = new Headers({ Accept: '*/*' });
  if (range) headers.set('Range', range);
  try {
    return await fetch(url, { method, headers, redirect: 'follow', cache: 'no-store' });
  } catch {
    return null;
  }
}

function downloadHeaders(request: Request, file: string, response: Response) {
  const requestedFilename = new URL(request.url).searchParams.get('filename');
  const firstDot = file.indexOf('.');
  const requiredExtension = firstDot >= 0 ? file.slice(firstDot) : '';
  const downloadFilename = normalizeDownloadFilename(requestedFilename, requiredExtension, file);
  const headers = new Headers({
    'Accept-Ranges': response.headers.get('accept-ranges') || 'bytes',
    'Cache-Control': 'public, max-age=300, s-maxage=3600',
    'Content-Disposition': `attachment; filename="${downloadFilename}"`,
    'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
  });
  for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function serveIndividual(request: Request, upstream: string, file: string, headOnly: boolean) {
  const requestedRange = request.headers.get('range');
  let normalizedRange: string | undefined;
  let logicalRange: ReturnType<typeof parseLogicalRange> = null;
  let logicalSize: number | null = null;
  let metadataResponse: Response | null = null;
  if (requestedRange) {
    metadataResponse = await fetchUpstream(upstream, 'HEAD');
    if (!metadataResponse) return NextResponse.json({ error: 'Remote release asset could not be reached.' }, { status: 502 });
    if (!metadataResponse.ok) return NextResponse.json({ error: 'Remote release asset is unavailable.' }, { status: metadataResponse.status === 404 ? 404 : 502 });
    logicalSize = Number(metadataResponse.headers.get('content-length'));
    if (!Number.isSafeInteger(logicalSize) || logicalSize < 0) return NextResponse.json({ error: 'Remote release asset length is invalid.' }, { status: 502 });
    logicalRange = parseLogicalRange(requestedRange, logicalSize);
    if (!logicalRange) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + logicalSize } });
    normalizedRange = 'bytes=' + logicalRange.start + '-' + logicalRange.end;
    if (headOnly) {
      const headers = downloadHeaders(request, file, metadataResponse);
      headers.set('Content-Length', String(logicalRange.end - logicalRange.start + 1));
      headers.set('Content-Range', 'bytes ' + logicalRange.start + '-' + logicalRange.end + '/' + logicalSize);
      return new Response(null, { status: 206, headers });
    }
  }

  const response = await fetchUpstream(upstream, headOnly ? 'HEAD' : 'GET', normalizedRange);
  if (!response) return NextResponse.json({ error: 'Remote release asset could not be reached.' }, { status: 502 });
  if (!response.ok && response.status !== 416) {
    return NextResponse.json({ error: 'Remote release asset is unavailable.' }, { status: response.status === 404 ? 404 : 502 });
  }
  if (logicalRange && logicalSize !== null) {
    const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    const expectedLength = logicalRange.end - logicalRange.start + 1;
    if (
      response.status !== 206 || !contentRange
      || Number(contentRange[1]) !== logicalRange.start || Number(contentRange[2]) !== logicalRange.end || Number(contentRange[3]) !== logicalSize
      || Number(response.headers.get('content-length')) !== expectedLength
    ) return NextResponse.json({ error: 'Remote release asset returned an invalid byte range.' }, { status: 502 });
  }
  return new Response(headOnly ? null : response.body, { status: response.status, headers: downloadHeaders(request, file, response) });
}

function parseLogicalRange(value: string | null, size: number) {
  if (!value) return { start: 0, end: Math.max(0, size - 1), partial: false };
  if (value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1), partial: true };
}

async function servePacked(request: Request, storage: Extract<NonNullable<Awaited<ReturnType<typeof genomeCatalogRepository.getByAccession>>>['storage'], { layout: 'packed-v1' }>, file: string, headOnly: boolean) {
  const asset = storage.assets[file];
  const base = storage.baseUrl?.replace(/\/+$/, '');
  if (!asset || !base) return NextResponse.json({ error: 'Remote release asset is unavailable.' }, { status: 404 });
  const range = parseLogicalRange(request.headers.get('range'), asset.length);
  if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + asset.length } });
  const requestedFilename = new URL(request.url).searchParams.get('filename');
  const firstDot = file.indexOf('.');
  const requiredExtension = firstDot >= 0 ? file.slice(firstDot) : '';
  const downloadFilename = normalizeDownloadFilename(requestedFilename, requiredExtension, file);
  const responseHeaders = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=300, s-maxage=3600',
    'Content-Disposition': 'attachment; filename="' + downloadFilename + '"',
    'Content-Length': String(range.end - range.start + 1),
    'Content-Type': asset.contentType || 'application/octet-stream',
    ETag: '"sha256-' + asset.sha256 + '"',
  });
  if (range.partial) responseHeaders.set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + asset.length);
  if (headOnly) return new Response(null, { status: range.partial ? 206 : 200, headers: responseHeaders });

  const physicalStart = asset.offset + range.start;
  const physicalEnd = asset.offset + range.end;
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(base + '/' + asset.packPath, {
      headers: { Accept: '*/*', Range: 'bytes=' + physicalStart + '-' + physicalEnd },
      redirect: 'follow',
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'Remote release asset could not be reached.' }, { status: 502 });
  }
  const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(upstreamResponse.headers.get('content-range') || '');
  const expectedLength = physicalEnd - physicalStart + 1;
  if (
    upstreamResponse.status !== 206 || !contentRange
    || Number(contentRange[1]) !== physicalStart || Number(contentRange[2]) !== physicalEnd || Number(contentRange[3]) <= physicalEnd
    || Number(upstreamResponse.headers.get('content-length')) !== expectedLength
  ) {
    return NextResponse.json({ error: 'Remote pack returned an invalid byte range.' }, { status: 502 });
  }
  for (const name of ['last-modified']) {
    const value = upstreamResponse.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstreamResponse.body, { status: range.partial ? 206 : 200, headers: responseHeaders });
}

export function GET(request: Request, context: RouteContext) {
  return serve(request, context, false);
}

export function HEAD(request: Request, context: RouteContext) {
  return serve(request, context, true);
}
