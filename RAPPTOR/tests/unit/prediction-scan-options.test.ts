import { describe, expect, it } from 'vitest';
import { genomeScanOutputs } from '@/features/prediction/scan-options';

describe('automatic peak outputs', () => {
  const service = { supportsPeakCalling: true, supportsScoreCutoff: true, gff3RequiresStride1: true };
  it('requests dense GFF3 and fixed peak cutoff automatically', () => {
    expect(genomeScanOutputs(1, service, .4)).toEqual({ output_formats: ['bigwig', 'gff3'], score_cutoff: .9 });
  });
  it.each([5, 10, 20])('retains full scores without requesting unsupported GFF at stride %i', (stride) => {
    expect(genomeScanOutputs(stride, service, .4)).toEqual({ output_formats: ['bigwig', 'parquet'] });
  });
  it('preserves the legacy service request', () => {
    expect(genomeScanOutputs(20, { supportsScoreCutoff: true }, .4)).toEqual({ output_formats: ['bigwig', 'gff3'], score_cutoff: .4 });
    expect(genomeScanOutputs(1, { supportsScoreCutoff: false }, .4)).toEqual({ output_formats: ['bigwig', 'parquet'] });
  });
});
