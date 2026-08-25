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
  'reference.fa',
  'reference.fa.gz',
  'reference.fa.gz.fai',
  'reference.fa.gz.gzi',
  'predicted-promoters.gff3.gz',
  'predicted-promoters.gff3.gz.tbi',
  'promoter-scores.plus.bw',
  'promoter-scores.minus.bw',
  'ncbi-annotations.gff3.gz',
  'ncbi-annotations.gff3.gz.tbi',
  'metadata.json',
]);

const CONTENT_TYPES: Record<string, string> = {
  'reference.fa': 'text/plain; charset=utf-8',
  'reference.fa.gz': 'application/gzip',
  'reference.fa.gz.fai': 'text/plain; charset=utf-8',
  'reference.fa.gz.gzi': 'application/octet-stream',
  'predicted-promoters.gff3.gz': 'application/gzip',
  'predicted-promoters.gff3.gz.tbi': 'application/octet-stream',
  'promoter-scores.plus.bw': 'application/x-bigwig',
  'promoter-scores.minus.bw': 'application/x-bigwig',
  'ncbi-annotations.gff3.gz': 'application/gzip',
  'ncbi-annotations.gff3.gz.tbi': 'application/octet-stream',
  'metadata.json': 'application/json; charset=utf-8',
};

type CatalogMatch = NonNullable<Awaited<ReturnType<typeof genomeCatalogRepository.getByAccession>>>;

const FILE_ASSET_KEYS: Record<string, keyof CatalogMatch['genome']['assets']> = {
  'reference.fa': 'fasta',
  'reference.fa.gz': 'fasta',
  'reference.fa.gz.fai': 'fastaFai',
  'reference.fa.gz.gzi': 'fastaGzi',
  'predicted-promoters.gff3.gz': 'predictedPromoters',
  'predicted-promoters.gff3.gz.tbi': 'predictedPromotersIndex',
  'promoter-scores.plus.bw': 'promoterScoresPlus',
  'promoter-scores.minus.bw': 'promoterScoresMinus',
  'ncbi-annotations.gff3.gz': 'ncbiAnnotations',
  'ncbi-annotations.gff3.gz.tbi': 'ncbiAnnotationsIndex',
  'metadata.json': 'metadata',
};

type RouteContext = {
  params: Promise<{ accession: string; file: string }>;
};

function dataRoot(releaseId: string) {
  return process.env.LOCAL_DATA_ROOT || join(process.cwd(), '.data', 'releases', releaseId, 'objects');
}

function localAssetPath(
  match: CatalogMatch,
  file: string,
) {
  if (!match.storage || match.storage.layout !== 'individual-v1') return null;
  const key = FILE_ASSET_KEYS[file];
  const configured = key ? match.genome.assets[key] : null;
  const prefix = match.storage.logicalObjectPrefix.startsWith('objects/')
    ? match.storage.logicalObjectPrefix.slice('objects/'.length)
    : match.storage.logicalObjectPrefix;
  if (typeof configured !== 'string' || !configured) return null;
  const withoutQuery = configured.split(/[?#]/u, 1)[0];
  if (!withoutQuery || withoutQuery.startsWith('/') || withoutQuery.includes('\\')) return null;
  const relative = withoutQuery.startsWith('objects/') ? withoutQuery.slice('objects/'.length) : withoutQuery;
  if (relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return relative === `${prefix}/${file}` ? relative : null;
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
  if (match.resourceStatus === 'staged' || !match.storage) {
    return NextResponse.json({ error: 'Release asset is still being prepared.' }, { status: 503 });
  }
  const relativePath = localAssetPath(match, file);
  if (!relativePath) return NextResponse.json({ error: 'Unknown release asset.' }, { status: 404 });
  const path = join(dataRoot(match.releaseId), ...relativePath.split('/'));
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
