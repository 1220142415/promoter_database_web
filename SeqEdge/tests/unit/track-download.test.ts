import { describe, expect, it } from 'vitest';
import {
  defaultTrackDownloadFilename,
  normalizeDownloadFilename,
  regionTrackDownloadUrl,
  visibleTrackRegion,
  wholeTrackDownloadUrl,
  type TrackDownloadMetadata,
} from '@/lib/track-download';

const metadata: TrackDownloadMetadata = {
  kind: 'promoters',
  accession: 'GCA_000411415.1',
  label: 'RAPPtor predicted promoter peaks',
  regionExportBase: '/api/local-region',
  wholeAssetUrl: '/api/local-data/GCA_000411415.1/predicted-promoters.gff3.gz',
};

describe('track download helpers', () => {
  it('builds stable visible-region and whole-track filenames', () => {
    const region = { refName: 'CP003597.1', start: 10, end: 20 };
    expect(defaultTrackDownloadFilename(metadata, 'visible', region)).toBe(
      'RAPPtor-promoters_GCA_000411415.1_CP003597.1_10-20.gff3',
    );
    expect(defaultTrackDownloadFilename(metadata, 'whole', region)).toBe(
      'RAPPtor-promoters_GCA_000411415.1.gff3.gz',
    );
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
});
