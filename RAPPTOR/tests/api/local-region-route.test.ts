import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exportRegion } = vi.hoisted(() => ({ exportRegion: vi.fn() }));
vi.mock('@/features/genome-browser/local-region-export', () => ({ exportRegion }));

import { GET } from '@/app/api/local-region/[accession]/route';

const accession = 'GCA_000411415.1';
const context = { params: Promise.resolve({ accession }) };

function request(query: string) {
  return new Request(`http://localhost/api/local-region/${accession}?${query}`);
}

beforeEach(() => {
  exportRegion.mockReset();
  exportRegion.mockResolvedValue({
    accession,
    locus: 'KE150450.1:1-20',
    sequence: Buffer.from('>KE150450.1:1-20\nACGT\n'),
    gff3: Buffer.from('##gff-version 3\n##source-track promoters\n'),
    tracks: ['promoters'],
  });
});

describe('local region export route', () => {
  it('returns a region FASTA attachment without requiring selected tracks', async () => {
    const response = await GET(request('ref=KE150450.1&start=1&end=20&format=fasta'), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('.fa');
    expect(await response.text()).toContain('>KE150450.1:1-20');
    expect(exportRegion).toHaveBeenCalledWith(expect.objectContaining({ tracks: [] }), 'fasta');
  });

  it('returns selected regional tracks as a GFF3 attachment', async () => {
    const response = await GET(request('ref=KE150450.1&start=1&end=20&tracks=promoters,ncbi&format=gff3&filename=../selected.txt'), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('filename="selected.gff3"');
    expect(await response.text()).toContain('##source-track promoters');
    expect(exportRegion).toHaveBeenCalledWith(expect.objectContaining({ tracks: ['promoters', 'ncbi'] }), 'gff3');
  });

  it('rejects unsupported formats before exporting', async () => {
    const response = await GET(request('ref=KE150450.1&start=1&end=20&tracks=promoters&format=bed'), context);
    expect(response.status).toBe(400);
    expect(exportRegion).not.toHaveBeenCalled();
  });

  it('does not expose unavailable tracks', async () => {
    exportRegion.mockRejectedValueOnce(new Error('NCBI annotation track is not available for this genome.'));
    const response = await GET(request('ref=KE150450.1&start=1&end=20&tracks=ncbi&format=gff3'), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'NCBI annotation track is not available for this genome.' });
  });
});
