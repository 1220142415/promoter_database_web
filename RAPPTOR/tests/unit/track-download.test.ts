import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserTrackDownloadBlob,
  defaultTrackDownloadFilename,
  normalizeDownloadFilename,
  regionTrackDownloadUrl,
  trackDownloadSettings,
  visibleTrackRegion,
  wholeTrackDownloadUrl,
  type TrackDownloadMetadata,
} from '@/features/genome-browser/track-download';

afterEach(() => vi.unstubAllGlobals());

const metadata: TrackDownloadMetadata = {
  kind: 'promoters',
  accession: 'GCA_000411415.1',
  label: 'RAPPTOR predicted promoter peaks',
  regionExportBase: '/api/local-region',
  wholeAssetUrl: '/api/local-data/GCA_000411415.1/predicted-promoters.gff3.gz',
};

describe('track download helpers', () => {
  it('builds stable visible-region and whole-track filenames', () => {
    const region = { refName: 'CP003597.1', start: 10, end: 20 };
    expect(defaultTrackDownloadFilename(metadata, 'visible', region)).toBe(
      'RAPPTOR-promoters_GCA_000411415.1_CP003597.1_10-20.gff3',
    );
    expect(defaultTrackDownloadFilename(metadata, 'whole', region)).toBe(
      'RAPPTOR-promoters_GCA_000411415.1.gff3.gz',
    );
  });

  it('uses whole-file BigWig names for raw score tracks', () => {
    const scores: TrackDownloadMetadata = {
      ...metadata,
      kind: 'scores-minus',
      label: 'RAPPTOR raw model scores (- strand)',
      wholeAssetUrl: '/api/local-data/GCA_000411415.1/promoter-scores.minus.bw',
      visibleRegionDownload: false,
    };
    expect(trackDownloadSettings(scores.kind).format).toBe('bigwig');
    expect(defaultTrackDownloadFilename(scores, 'whole', null)).toBe('RAPPTOR-raw-scores-minus_GCA_000411415.1.bw');
    expect(wholeTrackDownloadUrl(scores, 'minus_scores.bw')).toContain('filename=minus_scores.bw');
  });

  it('removes paths and unsafe characters while enforcing the required extension', () => {
    expect(normalizeDownloadFilename('../my promoter?.txt', '.gff3', 'fallback.gff3')).toBe('my_promoter.gff3');
    expect(normalizeDownloadFilename('custom.fa.gz', '.gff3.gz', 'fallback.gff3.gz')).toBe('custom.gff3.gz');
    expect(normalizeDownloadFilename('..', '.fa', 'reference.fa')).toBe('reference.fa');
  });

  it('returns a single-reference visible interval and rejects cross-reference views', () => {
    expect(visibleTrackRegion({
      width: 100,
      pxToBp: (px) => px === 0
        ? { refName: 'contig_1', coord: 10.8 }
        : { refName: 'contig_1', coord: 21.2 },
    })).toEqual({ refName: 'contig_1', start: 10, end: 21 });
    expect(visibleTrackRegion({
      width: 100,
      pxToBp: (px) => ({ refName: px === 0 ? 'contig_1' : 'contig_2', coord: 10 }),
    })).toBeNull();
  });

  it('builds a single-track regional URL and a named whole-track URL', () => {
    const region = { refName: 'CP003597.1', start: 10, end: 20 };
    const regionUrl = new URL(regionTrackDownloadUrl(metadata, region, 'custom.gff3'), 'http://localhost');
    expect(regionUrl.searchParams.get('tracks')).toBe('promoters');
    expect(regionUrl.searchParams.get('filename')).toBe('custom.gff3');
    expect(wholeTrackDownloadUrl(metadata, 'custom.gff3.gz')).toBe(
      '/api/local-data/GCA_000411415.1/predicted-promoters.gff3.gz?filename=custom.gff3.gz',
    );
  });

  it('exports a visible FASTA interval from a browser-prepared assembly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '>contig_1 first\nAACCGGTT\n>contig_2\nTTTT\n',
    )));
    const blob = await browserTrackDownloadBlob({
      ...metadata,
      kind: 'reference',
      wholeAssetUrl: 'blob:reference',
      downloadMode: 'browser',
    }, 'visible', { refName: 'contig_1', start: 3, end: 6 });
    expect(await blob.text()).toBe('>contig_1:3-6\nCCGG\n');
  });

  it('exports overlapping GFF3 features from browser-prepared data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response([
      '##gff-version 3',
      'contig_1\tRAPPTOR\tpromoter\t5\t5\t.\t+\t.\tID=p1',
      'contig_1\tRAPPTOR\tpromoter\t50\t50\t.\t+\t.\tID=p2',
      'contig_2\tRAPPTOR\tpromoter\t7\t7\t.\t+\t.\tID=p3',
    ].join('\n'))));
    const blob = await browserTrackDownloadBlob({
      ...metadata,
      wholeAssetUrl: 'blob:promoters',
      downloadMode: 'browser',
    }, 'visible', { refName: 'contig_1', start: 1, end: 10 });
    expect(await blob.text()).toBe('##gff-version 3\ncontig_1\tRAPPTOR\tpromoter\t5\t5\t.\t+\t.\tID=p1\n');
  });
});
