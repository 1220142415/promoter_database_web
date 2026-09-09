import { describe, expect, it } from 'vitest';
import { genomeScanOutputs } from '@/features/prediction/scan-options';

describe('automatic peak outputs', () => {
  const service = { supportsPeakCalling: true, supportsScoreCutoff: true, gff3RequiresStride1: true };
  it('requests dense GFF3 with the selected peak cutoff', () => {
    expect(genomeScanOutputs(1, service, .4)).toEqual({ output_formats: ['bigwig', 'gff3'], score_cutoff: .4 });
  });
  it.each([5, 37, 100])('retains full score tracks and adds cutoff-filtered JSON at stride %i', (stride) => {
    expect(genomeScanOutputs(stride, service, .4)).toEqual({ output_formats: ['bigwig', 'parquet', 'json'], score_cutoff: .4 });
  });
  it.each([2, 37, 100])('requests peak GFF3 at stride %i when the service supports sampled peaks', (stride) => {
    expect(genomeScanOutputs(stride, { ...service, gff3RequiresStride1: false }, .4)).toEqual({ output_formats: ['bigwig', 'gff3'], score_cutoff: .4 });
  });
  it('preserves the legacy service request', () => {
    expect(genomeScanOutputs(20, { supportsScoreCutoff: true }, .4)).toEqual({ output_formats: ['bigwig', 'gff3'], score_cutoff: .4 });
    expect(genomeScanOutputs(1, { supportsScoreCutoff: false }, .4)).toEqual({ output_formats: ['bigwig', 'parquet'] });
  });
});
