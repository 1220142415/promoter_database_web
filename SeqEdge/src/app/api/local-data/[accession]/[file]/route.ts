import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { normalizeDownloadFilename } from '@/lib/track-download';
import { genomeCatalogRepository } from '@/lib/genome-catalog-repository';

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

const CONTENT_TYPES: Record<string, string> = {
  'reference.fa.gz': 'application/gzip',
  'reference.fa.gz.fai': 'text/plain; charset=utf-8',
  'reference.fa.gz.gzi': 'application/octet-stream',
  'predicted-promoters.gff3.gz': 'application/gzip',
  'predicted-promoters.gff3.gz.tbi': 'application/octet-stream',
  'ncbi-annotations.gff3.gz': 'application/gzip',
  'ncbi-annotations.gff3.gz.tbi': 'application/octet-stream',
  'metadata.json': 'application/json; charset=utf-8',
};

type RouteContext = {
  params: Promise<{ accession: string; file: string }>;
};

function dataRoot(releaseId: string) {
  return process.env.LOCAL_DATA_ROOT || join(process.cwd(), '.data', 'releases', releaseId, 'objects');
}

function parseRange(value: string | null, size: number) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid' as const;

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid' as const;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return 'invalid' as const;
  }
  return { start, end: Math.min(end, size - 1) };
}

async function serve(request: Request, context: RouteContext, headOnly: boolean) {
  const { accession, file } = await context.params;
  if (!ACCESSION_PATTERN.test(accession) || !ALLOWED_FILES.has(file)) {
    return NextResponse.json({ error: 'Unknown release asset.' }, { status: 404 });
  }

  const match = await genomeCatalogRepository.getByAccession(accession);
  if (!match) return NextResponse.json({ error: 'Unknown release asset.' }, { status: 404 });
  const path = join(dataRoot(match.releaseId), match.storage.logicalObjectPrefix, file);
  let details;
  try {
    details = await stat(path);
  } catch {
    return NextResponse.json({ error: 'Release asset is not available locally.' }, { status: 404 });
  }
  if (!details.isFile()) {
    return NextResponse.json({ error: 'Release asset is not a file.' }, { status: 404 });
  }

  const range = parseRange(request.headers.get('range'), details.size);
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${details.size}` },
    });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? details.size - 1;
  const requestedFilename = new URL(request.url).searchParams.get('filename');
  const firstDot = file.indexOf('.');
  const requiredExtension = firstDot >= 0 ? file.slice(firstDot) : '';
  const downloadFilename = normalizeDownloadFilename(requestedFilename, requiredExtension, file);
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Disposition': `attachment; filename="${downloadFilename}"`,
    'Content-Length': String(Math.max(0, end - start + 1)),
    'Content-Type': CONTENT_TYPES[file] || 'application/octet-stream',
  });
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${details.size}`);

  const body = headOnly
    ? null
    : Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
  return new Response(body, { status: range ? 206 : 200, headers });
}

export function GET(request: Request, context: RouteContext) {
  return serve(request, context, false);
}

export function HEAD(request: Request, context: RouteContext) {
  return serve(request, context, true);
}
