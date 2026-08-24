import { describe, expect, it } from 'vitest';
import { validateRegionExport } from '@/lib/local-region-export';

describe('region export contract', () => {
  it('accepts a bounded 1-based region and removes duplicate track ids', () => {
    expect(validateRegionExport({ accession: 'GCA_000411415.1', refName: 'CP003597.1', start: 1, end: 1000, tracks: ['promoters', 'promoters', 'ncbi'] })).toMatchObject({ tracks: ['promoters', 'ncbi'] });
  });

  it('allows a region FASTA export without annotation tracks', () => {
    expect(validateRegionExport({ accession: 'GCA_000411415.1', refName: 'CP003597.1', start: 1, end: 1000, tracks: [] }, false)).toMatchObject({ tracks: [] });
  });

  it.each([
    { accession: 'bad', refName: 'chr', start: 1, end: 10, tracks: ['promoters'] },
    { accession: 'GCA_000411415.1', refName: 'chr/../x', start: 1, end: 10, tracks: ['promoters'] },
    { accession: 'GCA_000411415.1', refName: 'chr', start: 10, end: 1, tracks: ['promoters'] },
    { accession: 'GCA_000411415.1', refName: 'chr', start: 1, end: 10, tracks: [] },
    { accession: 'GCA_000411415.1', refName: 'chr', start: 1, end: 10, tracks: ['secrets'] },
  ])('rejects unsafe region input %#', (input) => {
    expect(() => validateRegionExport(input)).toThrow();
  });
});
