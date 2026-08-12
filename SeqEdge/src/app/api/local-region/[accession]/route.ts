import { NextResponse } from 'next/server';
import { exportRegion, type RegionExportFormat } from '@/lib/local-region-export';
import {
  defaultTrackDownloadFilename,
  normalizeDownloadFilename,
  type TrackDownloadKind,
} from '@/lib/track-download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ accession: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { accession } = await context.params;
  const url = new URL(request.url);
  const start = Number(url.searchParams.get('start'));
  const end = Number(url.searchParams.get('end'));
  const refName = url.searchParams.get('ref') || '';
  const tracks = (url.searchParams.get('tracks') || '').split(',').filter(Boolean);
  const format = url.searchParams.get('format') || 'gff3';
  const requestedFilename = url.searchParams.get('filename');
  try {
    if (format !== 'fasta' && format !== 'gff3') throw new Error('Invalid export format.');
    const result = await exportRegion({ accession, refName, start, end, tracks }, format as RegionExportFormat);
    const kind: TrackDownloadKind = format === 'fasta'
      ? 'reference'
      : tracks.length === 1 && tracks[0] === 'promoters'
        ? 'promoters'
        : tracks.length === 1 && tracks[0] === 'ncbi'
          ? 'ncbi'
          : 'promoters';
    const fallbackFilename = tracks.length > 1
      ? `${accession}_${refName}_${start}-${end}.gff3`
      : defaultTrackDownloadFilename({ kind, accession }, 'visible', { refName, start, end });
    const requiredExtension = format === 'fasta' ? '.fa' : '.gff3';
    const downloadFilename = normalizeDownloadFilename(requestedFilename, requiredExtension, fallbackFilename);
    if (format === 'fasta') {
      return new Response(new Uint8Array(result.sequence), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${downloadFilename}"`,
          'Content-Length': String(result.sequence.byteLength),
        },
      });
    }
    return new Response(result.gff3, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${downloadFilename}"`,
        'Content-Length': String(result.gff3.byteLength),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Region export failed.';
    return NextResponse.json({ error: message }, { status: /Invalid|Select/.test(message) ? 400 : 404 });
  }
}
