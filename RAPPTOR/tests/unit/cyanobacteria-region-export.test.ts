import { describe, expect, it } from 'vitest';
import { validateCyanobacteriaRegionExport } from '@/features/cyanobacteria/region-export';

describe('cyanobacteria region export validation', () => {
  it('normalizes selected tracks and accepts the three stable identifiers', () => {
    expect(validateCyanobacteriaRegionExport({
      genomeId: 'CP003597.1', refName: 'CP003597.1', start: 1, end: 100,
      tracks: ['annotation', 'promoters', 'annotation'],
    }).tracks).toEqual(['annotation', 'promoters']);
  });

  it('rejects unknown genomes, unsafe refs, oversized intervals, and non-whitelisted tracks', () => {
    const base = { genomeId: 'ASM970v1', refName: 'NC_003272.1', start: 1, end: 100, tracks: ['promoters'] };
    expect(() => validateCyanobacteriaRegionExport({ ...base, genomeId: 'GCA_unknown' })).toThrow(/genome identifier/i);
    expect(() => validateCyanobacteriaRegionExport({ ...base, refName: '../reference' })).toThrow(/reference sequence/i);
    expect(() => validateCyanobacteriaRegionExport({ ...base, end: 5_000_001 })).toThrow(/5 Mb/i);
    expect(() => validateCyanobacteriaRegionExport({ ...base, tracks: ['ncbi'] })).toThrow(/annotation track/i);
    expect(validateCyanobacteriaRegionExport({ ...base, tracks: ['experimental-tss'] }).tracks).toEqual(['experimental-tss']);
    expect(() => validateCyanobacteriaRegionExport({ ...base, genomeId: 'Cf6912', tracks: ['experimental-tss'] })).toThrow(/not available/i);
  });
});
