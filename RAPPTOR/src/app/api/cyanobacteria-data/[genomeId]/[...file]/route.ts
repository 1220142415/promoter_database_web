import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import {
  cyanobacteriaAssetPath,
  cyanobacteriaAssetVersion,
  cyanobacteriaGenomeFiles,
  cyanobacteriaRelease,
  cyanobacteriaReleaseFiles,
  getCyanobacteriaGenome,
} from '@/features/cyanobacteria/catalog';
import { normalizeDownloadFilename } from '@/features/genome-browser/track-download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ genomeId: string; file: string[] }>;
};

function contentType(file: string) {
  if (file.endsWith('.bw')) return 'application/x-bigwig';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.tsv') || file.endsWith('.fai') || file.endsWith('.sha256')) return 'text/plain; charset=utf-8';
  if (file.endsWith('.gz')) return 'application/gzip';
  return 'application/octet-stream';
}

function allowedAsset(genomeId: string, file: string) {
  if (genomeId === 'release') return cyanobacteriaReleaseFiles().has(file);
  const genome = getCyanobacteriaGenome(genomeId);
  return genome ? cyanobacteriaGenomeFiles(genome).has(file) : false;
}

function parseRange(value: string | null, size: number) {
  if (!value) return null;
  if (value.includes(',')) return 'invalid' as const;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid' as const;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid' as const;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return 'invalid' as const;
  }
  return { start, end: Math.min(end, size - 1) };
}

function responseHeaders(request: Request, file: string, size: number, range: { start: number; end: number } | null, remote: boolean) {
  const requestedFilename = new URL(request.url).searchParams.get('filename');
  const basename = file.split('/').at(-1) || 'download';
  const firstDot = basename.indexOf('.');
  const extension = firstDot >= 0 ? basename.slice(firstDot) : '';
  const downloadFilename = normalizeDownloadFilename(requestedFilename, extension, basename);
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, size - 1);
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': remote
      ? 'public, max-age=31536000, s-maxage=31536000, immutable'
      : 'private, max-age=0, must-revalidate',
    'Content-Disposition': `attachment; filename="${downloadFilename}"`,
    'Content-Length': String(Math.max(0, end - start + 1)),
    'Content-Type': contentType(file),
  });
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  return headers;
}

function localRoot() {
  return process.env.CYANOBACTERIA_DATA_ROOT
    || join(process.cwd(), '.data', 'cyanobacteria', 'releases', cyanobacteriaRelease.releaseId);
}

async function serveLocal(request: Request, genomeId: string, file: string, headOnly: boolean) {
  const path = join(localRoot(), cyanobacteriaAssetPath(genomeId, file));
  let details;
  try {
    details = await stat(path);
  } catch {
    return NextResponse.json({ error: 'Cyanobacteria release asset is not available locally.' }, { status: 404 });
  }
  if (!details.isFile()) return NextResponse.json({ error: 'Cyanobacteria release asset is not a file.' }, { status: 404 });
  const range = parseRange(request.headers.get('range'), details.size);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${details.size}` } });
  const start = range?.start ?? 0;
  const end = range?.end ?? details.size - 1;
  const body = headOnly ? null : Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
  return new Response(body, {
    status: range ? 206 : 200,
    headers: responseHeaders(request, file, details.size, range, false),
  });
}

async function upstreamMetadata(upstream: string) {
  try {
    return await fetch(upstream, { method: 'HEAD', headers: { Accept: '*/*' }, redirect: 'follow', cache: 'no-store' });
  } catch {
    return null;
  }
}

async function serveRemote(request: Request, genomeId: string, file: string, headOnly: boolean) {
  const base = (process.env.CYANOBACTERIA_ASSET_BASE_URL || cyanobacteriaRelease.assetBaseUrl).replace(/\/+$/, '');
  const upstream = `${base}/${cyanobacteriaAssetPath(genomeId, file)}`;
  const requestedRange = request.headers.get('range');
  const metadata = await upstreamMetadata(upstream);
  if (!metadata) return NextResponse.json({ error: 'Cyanobacteria release storage could not be reached.' }, { status: 502 });
  if (!metadata.ok) return NextResponse.json({ error: 'Cyanobacteria release asset is unavailable.' }, { status: metadata.status === 404 ? 404 : 502 });
  const size = Number(metadata.headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size < 0) return NextResponse.json({ error: 'Cyanobacteria release asset length is invalid.' }, { status: 502 });
  const range = parseRange(requestedRange, size);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  if (headOnly) return new Response(null, {
    status: range ? 206 : 200,
    headers: responseHeaders(request, file, size, range, true),
  });

  const headers = new Headers({ Accept: '*/*' });
  if (range) headers.set('Range', `bytes=${range.start}-${range.end}`);
  let response;
  try {
    response = await fetch(upstream, { headers, redirect: 'follow', cache: 'no-store' });
  } catch {
    return NextResponse.json({ error: 'Cyanobacteria release storage could not be reached.' }, { status: 502 });
  }
  if (!response.ok) return NextResponse.json({ error: 'Cyanobacteria release asset is unavailable.' }, { status: response.status === 404 ? 404 : 502 });
  if (range) {
    const observed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (
      response.status !== 206 || !observed
      || Number(observed[1]) !== range.start || Number(observed[2]) !== range.end || Number(observed[3]) !== size
    ) return NextResponse.json({ error: 'Cyanobacteria release storage returned an invalid byte range.' }, { status: 502 });
  }
  return new Response(response.body, {
    status: range ? 206 : 200,
    headers: responseHeaders(request, file, size, range, true),
  });
}

async function serve(request: Request, context: RouteContext, headOnly: boolean) {
  const { genomeId, file: requestedParts } = await context.params;
  const version = `v-${cyanobacteriaAssetVersion}`;
  if (requestedParts[0]?.startsWith('v-') && requestedParts[0] !== version) {
    return NextResponse.json({ error: 'Unknown cyanobacteria asset version.' }, { status: 404 });
  }
  const parts = requestedParts[0] === version ? requestedParts.slice(1) : requestedParts;
  const file = parts.join('/');
  if (!allowedAsset(genomeId, file)) {
    return NextResponse.json({ error: 'Unknown cyanobacteria release asset.' }, { status: 404 });
  }
  const useRemote = Boolean(process.env.CYANOBACTERIA_ASSET_BASE_URL)
    || (process.env.NODE_ENV === 'production' && !process.env.CYANOBACTERIA_DATA_ROOT);
  return useRemote
    ? serveRemote(request, genomeId, file, headOnly)
    : serveLocal(request, genomeId, file, headOnly);
}

export function GET(request: Request, context: RouteContext) {
  return serve(request, context, false);
}

export function HEAD(request: Request, context: RouteContext) {
  return serve(request, context, true);
}
