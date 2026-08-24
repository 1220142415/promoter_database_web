import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_FILES = new Set(['catalog.json', 'release.json', 'manifest.tsv', 'checksums.sha256', 'manifest-index.json', 'packs-manifest.tsv']);
const CONTENT_TYPES: Record<string, string> = {
  'catalog.json': 'application/json; charset=utf-8',
  'release.json': 'application/json; charset=utf-8',
  'manifest.tsv': 'text/tab-separated-values; charset=utf-8',
  'checksums.sha256': 'text/plain; charset=utf-8',
  'manifest-index.json': 'application/json; charset=utf-8',
  'packs-manifest.tsv': 'text/tab-separated-values; charset=utf-8',
};

type RouteContext = { params: Promise<{ file: string }> };

async function serve(context: RouteContext, headOnly: boolean) {
  const { file } = await context.params;
  if (!ALLOWED_FILES.has(file)) {
    return NextResponse.json({ error: 'Unknown release file.' }, { status: 404 });
  }
  const root = process.env.LOCAL_RELEASE_ROOT || join(process.cwd(), '.data', 'releases', '2026-08-07');
  const path = join(root, file);
  let details;
  try {
    details = await stat(path);
  } catch {
    return NextResponse.json({ error: 'Release file is not available locally.' }, { status: 404 });
  }
  if (!details.isFile()) {
    return NextResponse.json({ error: 'Release file is not a file.' }, { status: 404 });
  }
  const headers = new Headers({
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Length': String(details.size),
    'Content-Type': CONTENT_TYPES[file],
  });
  const body = headOnly ? null : Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new Response(body, { status: 200, headers });
}

export function GET(_request: Request, context: RouteContext) {
  return serve(context, false);
}

export function HEAD(_request: Request, context: RouteContext) {
  return serve(context, true);
}
