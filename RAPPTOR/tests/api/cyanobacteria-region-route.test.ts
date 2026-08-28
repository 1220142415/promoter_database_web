import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exportRegion } = vi.hoisted(() => ({ exportRegion: vi.fn() }));
vi.mock('@/features/cyanobacteria/region-export', () => ({ exportCyanobacteriaRegion: exportRegion }));

import { GET } from '@/app/api/cyanobacteria-region/[genomeId]/route';

const context = { params: Promise.resolve({ genomeId: 'Cf6912' }) };

beforeEach(() => {
  exportRegion.mockReset();
  exportRegion.mockResolvedValue({ locus: 'contig_1:1-20', data: Buffer.from('##gff-version 3\n') });
});

describe('cyanobacteria region export route', () => {
  it('exports the source-neutral annotation track with a safe filename', async () => {
    const request = new Request('http://localhost/api/cyanobacteria-region/Cf6912?ref=contig_1&start=1&end=20&tracks=annotation&format=gff3&filename=../selected.txt');
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('filename="selected.gff3"');
    expect(exportRegion).toHaveBeenCalledWith({
      genomeId: 'Cf6912', refName: 'contig_1', start: 1, end: 20, tracks: ['annotation'],
    }, 'gff3');
  });

  it('rejects unsupported formats before reading release data', async () => {
    const response = await GET(new Request('http://localhost/test?ref=contig_1&start=1&end=20&format=bed'), context);
    expect(response.status).toBe(400);
    expect(exportRegion).not.toHaveBeenCalled();
  });
});
