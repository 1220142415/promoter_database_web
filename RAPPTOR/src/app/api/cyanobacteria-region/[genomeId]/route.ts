import { NextResponse } from 'next/server';
import {
  exportCyanobacteriaRegion,
  type CyanobacteriaRegionExportFormat,
} from '@/features/cyanobacteria/region-export';
import { normalizeDownloadFilename } from '@/features/genome-browser/track-download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ genomeId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { genomeId } = await context.params;
  const url = new URL(request.url);
  const start = Number(url.searchParams.get('start'));
  const end = Number(url.searchParams.get('end'));
  const refName = url.searchParams.get('ref') || '';
  const tracks = (url.searchParams.get('tracks') || '').split(',').filter(Boolean);
  const format = url.searchParams.get('format') || 'gff3';
  try {
    if (format !== 'fasta' && format !== 'gff3') throw new Error('Invalid export format.');
    const result = await exportCyanobacteriaRegion(
      { genomeId, refName, start, end, tracks },
      format as CyanobacteriaRegionExportFormat,
    );
    const extension = format === 'fasta' ? '.fa' : '.gff3';
    const fallback = `${genomeId}_${refName}_${start}-${end}${extension}`;
    const filename = normalizeDownloadFilename(url.searchParams.get('filename'), extension, fallback);
    return new Response(result.data, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(result.data.byteLength),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Region export failed.';
    return NextResponse.json({ error: message }, { status: /Invalid|Select|limit/.test(message) ? 400 : 404 });
  }
}
