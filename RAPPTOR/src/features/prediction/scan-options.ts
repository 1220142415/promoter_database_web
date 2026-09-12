import type { QueuedPredictionCapabilities } from './service-capabilities';

export function genomeScanOutputs(stride: number, service: Pick<QueuedPredictionCapabilities, 'supportsScoreCutoff' | 'supportsPromoterOutput' | 'supportsPeakCalling' | 'gff3RequiresStride1'>, cutoff: number) {
  const supportsPromoters = service.supportsPromoterOutput ?? service.supportsPeakCalling;
  if (supportsPromoters && (stride === 1 || service.gff3RequiresStride1 === false)) {
    return { output_formats: ['bigwig', 'gff3'], score_cutoff: cutoff };
  }
  if (!service.supportsScoreCutoff) {
    return { output_formats: ['bigwig', 'parquet'] };
  }
  if (service.gff3RequiresStride1) {
    return { output_formats: ['bigwig', 'parquet', 'json'], score_cutoff: cutoff };
  }
  return { output_formats: ['bigwig', 'gff3'], score_cutoff: cutoff };
}
