import { NextResponse } from 'next/server';
import { experimentalTssRepository } from '@/features/genome-browser/experimental-tss-repository';
import { experimentalTssPublicEnabled } from '@/features/genome-browser/experimental-tss-public';
import { normalizeDownloadFilename } from '@/features/genome-browser/track-download';
import type { ExperimentalAssetTransform } from '@/types/experimental-tss';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ accession: string; asset: string[] }>;
};

type RequestedByteRange =
  | { kind: 'bounded'; start: number; end: number | null }
  | { kind: 'suffix'; length: number };

const MAX_TRANSFORMED_ASSET_BYTES = 32 * 1024 * 1024;

function gffAttribute(value: string) {
  return encodeURIComponent(value);
}

function bedToGff3(source: string, transform: Extract<ExperimentalAssetTransform, { kind: 'experimental-bed-to-gff3' }>) {
  const output = ['##gff-version 3'];
  let row = 0;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const columns = line.split('\t');
    if (columns.length < 6) throw new Error('BED row has fewer than six columns');
    const start = Number(columns[1]);
    const end = Number(columns[2]);
    const strand = columns[5];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || !['+', '-', '.'].includes(strand)) {
      throw new Error('BED row is invalid');
    }
    const prefixedRefName = columns[0];
    const refName = prefixedRefName.startsWith(`${transform.accession}:`)
      ? prefixedRefName.slice(transform.accession.length + 1)
      : prefixedRefName;
    if (!refName || /[\t\r\n]/u.test(refName)) throw new Error('BED reference name is invalid');
    row += 1;
    const attributes = [
      `ID=${gffAttribute(`${transform.studyId}:${row}`)}`,
      `Name=${gffAttribute(columns[3] || '.')}`,
      `description=${gffAttribute(columns[3] || '.')}`,
      `study_id=${gffAttribute(transform.studyId)}`,
      `pmid=${gffAttribute(transform.pmid)}`,
      `year=${transform.year}`,
      transform.sourceFile ? `source_file=${gffAttribute(transform.sourceFile)}` : null,
      `raw_row=${row}`,
      'evidence_type=experimental',
    ].filter(Boolean).join(';');
    const score = columns[4] && columns[4] !== '' ? columns[4] : '.';
    output.push([refName, 'RAPPTOR', 'experimental_tss', start + 1, end, score, strand, '.', attributes].join('\t'));
  }
  if (!row) throw new Error('BED contains no observations');
  return `${output.join('\n')}\n`;
}

async function transformedAsset(upstream: Response, transform: ExperimentalAssetTransform) {
  const declaredLength = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TRANSFORMED_ASSET_BYTES) throw new Error('asset is too large');
  if (transform.kind === 'gunzip') {
    if (!upstream.body) throw new Error('asset body is missing');
    const body = upstream.body.pipeThrough(new DecompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    if (bytes.byteLength > MAX_TRANSFORMED_ASSET_BYTES) throw new Error('asset is too large');
    if (!transform.refName) return bytes;
    const fasta = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!fasta.startsWith('>')) throw new Error('FASTA header is missing');
    return new TextEncoder().encode(fasta.replace(/^>[^\s]+/u, `>${transform.refName}`));
  }
  const source = await upstream.text();
  if (new TextEncoder().encode(source).byteLength > MAX_TRANSFORMED_ASSET_BYTES) throw new Error('asset is too large');
  return new TextEncoder().encode(bedToGff3(source, transform));
}

function parseSingleByteRange(value: string | null): RequestedByteRange | null {
  if (!value || value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const length = Number(match[2]);
    return Number.isSafeInteger(length) && length > 0 ? { kind: 'suffix', length } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (!Number.isSafeInteger(start) || start < 0 || (end !== null && (!Number.isSafeInteger(end) || end < start))) return null;
  return { kind: 'bounded', start, end };
}

function validPartialResponse(requested: RequestedByteRange, response: Response) {
  const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (!contentRange) return false;
  const start = Number(contentRange[1]);
  const end = Number(contentRange[2]);
  const total = Number(contentRange[3]);
  const contentLength = Number(response.headers.get('content-length'));
  if (
    ![start, end, total, contentLength].every(Number.isSafeInteger)
    || total <= 0 || start < 0 || end < start || end >= total
    || contentLength !== end - start + 1
  ) return false;
  if (requested.kind === 'suffix') {
    return start === Math.max(0, total - requested.length) && end === total - 1;
  }
  if (requested.start >= total || start !== requested.start) return false;
  const expectedEnd = requested.end === null ? total - 1 : Math.min(requested.end, total - 1);
  return end === expectedEnd;
}

function responseHeaders(request: Request, upstream: Response, asset: Awaited<ReturnType<typeof experimentalTssRepository.resolveAsset>>) {
  if (!asset) return new Headers();
  const params = new URL(request.url).searchParams;
  const download = params.get('download') === '1';
  const filename = download && asset.kind === 'raw-bed' && params.has('filename')
    ? normalizeDownloadFilename(params.get('filename'), asset.filename.endsWith('.gz') ? '.bed.gz' : '.bed', asset.filename)
    : asset.filename;
  const headers = new Headers({
    'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
    'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
    'Content-Type': asset.contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('etag') && asset.sha256) headers.set('ETag', `"sha256-${asset.sha256}"`);
  return headers;
}

async function serve(request: Request, context: RouteContext, headOnly: boolean) {
  if (!experimentalTssPublicEnabled()) {
    return NextResponse.json({ error: 'Unknown release asset.' }, { status: 404 });
  }
  const { accession, asset: parts } = await context.params;
  if (!Array.isArray(parts) || parts.length === 0) {
    return NextResponse.json({ error: 'Unknown experimental release asset.' }, { status: 404 });
  }
  const logicalAsset = parts.join('/');
  let asset;
  try { asset = await experimentalTssRepository.resolveAsset(accession, logicalAsset); } catch {
    return NextResponse.json({ error: 'Experimental release assets are unavailable.' }, { status: 503 });
  }
  if (!asset) return NextResponse.json({ error: 'Unknown experimental release asset.' }, { status: 404 });

  const headers = new Headers({ Accept: '*/*' });
  const range = request.headers.get('range');
  const requestedRange = range ? parseSingleByteRange(range) : null;
  if (range && !requestedRange) {
    return new Response(null, { status: 416 });
  }
  if (range && asset.transform) return new Response(null, { status: 416 });
  if (range) headers.set('Range', range);
  let upstream;
  try {
    upstream = await fetch(asset.upstreamUrl, {
      method: headOnly && !asset.transform ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'Experimental release asset could not be reached.' }, { status: 502 });
  }
  if (!upstream.ok && upstream.status !== 416) {
    return NextResponse.json({ error: 'Experimental release asset is unavailable.' }, { status: upstream.status === 404 ? 404 : 502 });
  }
  if (range && ![206, 416].includes(upstream.status)) {
    return NextResponse.json({ error: 'Experimental release asset did not honor the byte range.' }, { status: 502 });
  }
  if (requestedRange && upstream.status === 206 && !validPartialResponse(requestedRange, upstream)) {
    return NextResponse.json({ error: 'Experimental release asset returned an invalid byte range.' }, { status: 502 });
  }
  if (asset.transform) {
    try {
      const body = await transformedAsset(upstream, asset.transform);
      const headers = responseHeaders(request, upstream, asset);
      headers.delete('Accept-Ranges');
      headers.delete('Content-Range');
      headers.set('Content-Length', String(body.byteLength));
      if (asset.sha256) headers.set('ETag', `W/"sha256-${asset.sha256}-${asset.transform.kind}"`);
      return new Response(headOnly ? null : body, { status: 200, headers });
    } catch {
      return NextResponse.json({ error: 'Experimental release asset could not be transformed.' }, { status: 502 });
    }
  }
  return new Response(headOnly ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders(request, upstream, asset),
  });
}

export function GET(request: Request, context: RouteContext) {
  return serve(request, context, false);
}

export function HEAD(request: Request, context: RouteContext) {
  return serve(request, context, true);
}
