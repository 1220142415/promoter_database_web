import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
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
const IMMUTABLE_FILES = new Set([
  'reference.fa.gz.fai',
  'reference.fa.gz.gzi',
  'predicted-promoters.gff3.gz.tbi',
  'ncbi-annotations.gff3.gz.tbi',
  'metadata.json',
]);

type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

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

function edgeCache() {
  const cache = (globalThis as typeof globalThis & { caches?: { default?: EdgeCache } }).caches?.default;
  return cache || null;
}

function cacheKey(request: Request, method: string, range: string | null) {
  const url = new URL(request.url);
  url.searchParams.set('__seqedge_cache_method', method);
  url.searchParams.set('__seqedge_cache_range', range || 'full');
  return new Request(url.toString(), { method: 'GET' });
}

function cacheControl(file: string, ranged: boolean, versioned: boolean) {
  if (versioned && IMMUTABLE_FILES.has(file)) return 'public, max-age=31536000, s-maxage=31536000, immutable';
  if (ranged) return 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';
  return 'public, max-age=300, s-maxage=3600';
}

async function cachedResponse(key: Request | null) {
  if (!key) return null;
  try {
    const cached = await edgeCache()?.match(key);
    if (!cached) return null;
    const headers = new Headers(cached.headers);
    const status = Number(headers.get('x-seqedge-cached-status') || cached.status);
    headers.delete('x-seqedge-cached-status');
    headers.set('X-SeqEdge-Cache', 'HIT');
    return new Response(cached.body, { status, headers });
  } catch { return null; }
}

async function storeResponse(key: Request | null, response: Response) {
  if (!key || ![200, 206].includes(response.status)) return;
  try {
    const cached = response.clone();
    const headers = new Headers(cached.headers);
    headers.set('x-seqedge-cached-status', String(cached.status));
    const write = edgeCache()?.put(key, new Response(cached.body, { status: 200, headers }));
    if (!write) return;
    try { getCloudflareContext().ctx.waitUntil(write); } catch { await write; }
  } catch { /* Cache API is optional in local Node tests. */ }
}

async function serve(request: Request, context: RouteContext, headOnly: boolean) {
  const { accession, file } = await context.params;
  if (!ACCESSION_PATTERN.test(accession) || !ALLOWED_FILES.has(file)) {
    return NextResponse.json({ error: 'Unknown remote release asset.' }, { status: 404 });
  }
  const range = request.headers.get('range');
  const versioned = Boolean(new URL(request.url).searchParams.get('release'));
  const cacheable = versioned && (Boolean(range) || IMMUTABLE_FILES.has(file));
  const key = cacheable ? cacheKey(request, headOnly ? 'HEAD' : 'GET', range) : null;
  const hit = await cachedResponse(key);
  if (hit) return hit;
  const match = await genomeCatalogRepository.getByAccession(accession);
  if (!match) return NextResponse.json({ error: 'Unknown remote release asset.' }, { status: 404 });
  const completeRelease = Boolean(process.env.HF_STORAGE_BASE_URL || process.env.NODE_ENV === 'production' || process.env.SEQEDGE_CATALOG_BACKEND === 'd1');
  if (!completeRelease && !pilotAccessions().has(accession)) return NextResponse.json({ error: 'Unknown remote release asset.' }, { status: 404 });
  let response: Response;
  if (match.storage.layout === 'packed-v1') response = await servePacked(request, match.storage, file, headOnly);
  else {
    const upstream = individualUpstream(match.storage, accession, file);
    if (!upstream) return NextResponse.json({ error: 'Remote storage is not configured.' }, { status: 503 });
    response = await serveIndividual(request, upstream, file, headOnly);
  }
  response.headers.set('X-SeqEdge-Cache', key ? 'MISS' : 'BYPASS');
  await storeResponse(key, response);
  return response;
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

function downloadHeaders(request: Request, file: string, response: Response, ranged = false) {
  const requestedFilename = new URL(request.url).searchParams.get('filename');
  const firstDot = file.indexOf('.');
  const requiredExtension = firstDot >= 0 ? file.slice(firstDot) : '';
  const downloadFilename = normalizeDownloadFilename(requestedFilename, requiredExtension, file);
  const headers = new Headers({
    'Accept-Ranges': response.headers.get('accept-ranges') || 'bytes',
    'Cache-Control': cacheControl(file, ranged, Boolean(new URL(request.url).searchParams.get('release'))),
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
    const metadataKey = cacheKey(request, 'HEAD-METADATA', null);
    metadataResponse = await cachedResponse(metadataKey);
    if (!metadataResponse) {
      metadataResponse = await fetchUpstream(upstream, 'HEAD');
      if (metadataResponse?.ok) {
        const metadataHeaders = new Headers(metadataResponse.headers);
        metadataHeaders.set('Cache-Control', cacheControl(file, false, true));
        metadataResponse = new Response(null, { status: metadataResponse.status, headers: metadataHeaders });
        await storeResponse(metadataKey, metadataResponse);
      }
    }
    if (!metadataResponse) return NextResponse.json({ error: 'Remote release asset could not be reached.' }, { status: 502 });
    if (!metadataResponse.ok) return NextResponse.json({ error: 'Remote release asset is unavailable.' }, { status: metadataResponse.status === 404 ? 404 : 502 });
    logicalSize = Number(metadataResponse.headers.get('content-length'));
    if (!Number.isSafeInteger(logicalSize) || logicalSize < 0) return NextResponse.json({ error: 'Remote release asset length is invalid.' }, { status: 502 });
    logicalRange = parseLogicalRange(requestedRange, logicalSize);
    if (!logicalRange) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + logicalSize } });
    normalizedRange = 'bytes=' + logicalRange.start + '-' + logicalRange.end;
    if (headOnly) {
      const headers = downloadHeaders(request, file, metadataResponse, true);
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
  return new Response(headOnly ? null : response.body, { status: response.status, headers: downloadHeaders(request, file, response, Boolean(logicalRange)) });
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
    'Cache-Control': cacheControl(file, range.partial, Boolean(new URL(request.url).searchParams.get('release'))),
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
