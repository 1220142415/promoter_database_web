export type JobArtifact = { filename: string; format: string; size_bytes: number; sha256: string };

export type JobSummary = {
  mode?: 'genome_scan' | 'predict';
  total_bases?: number;
  contig_count?: number;
  stride?: number;
  window_count?: number;
  passing_window_count?: number;
  promoter_count?: number | null;
  peak_count?: number | null;
  smoothing?: { method: string; sigma: number; mode: string } | null;
  bigwig_smoothing?: { method: string; sigma: number; mode: string } | null;
  peak_calling?: {
    distance: number; distance_unit?: string; sample_distance?: number; resolution_bp?: number;
    window_length_bp?: number; upstream_bp?: number; downstream_bp?: number;
    cutoff: number; operator: string;
  } | null;
  promoter_selection?: {
    method: string; score?: string; distance_bp?: number;
    cutoff: number; operator: string;
  } | null;
  window_start_coordinate_system?: 'reference_0based';
  sequence_bases?: number;
  genome_context_bases?: number | null;
  reference_accession?: string | null;
  cgr_source?: string;
  score_cutoff?: number | null;
  score_cutoff_operator?: string | null;
  max_score?: number;
  reverse_complementary?: boolean;
  batch_size?: number;
  completed_at?: string;
  model?: {
    model_version?: string;
    model_asset_status?: string;
    seq_length?: number;
    checkpoint_sha256?: string;
    model_config_sha256?: string;
    model_source_commit?: string;
    device?: string;
    torch_version?: string;
  };
};

export const RESULT_TABLE_FILENAME = 'prediction-results.tsv';
export const SCORE_TRACKS_ZIP_FILENAME = 'model-score-tracks.zip';
export const SCORE_TRACK_FILENAMES = ['scores.plus.bw', 'scores.minus.bw'] as const;

export function resultTableSource(artifacts: readonly { filename: string }[], mode?: JobSummary['mode']) {
  const preferred = mode === 'predict' ? ['scores.json'] : ['scores.gff3', 'scores.json'];
  return preferred.find((filename) => artifacts.some((artifact) => artifact.filename === filename));
}

/** The first smoothed-peaks release used reference starts before adding an explicit marker. */
export function windowCoordinateSystem(summary: JobSummary) {
  return summary.window_start_coordinate_system
    ?? (summary.smoothing?.method === 'gaussian' && summary.smoothing.mode === 'reflect' && summary.peak_calling ? 'reference_0based' : undefined);
}

/** Legacy starts use strand orientation; newer artifacts explicitly use reference coordinates. */
export function referenceWindow(start: number, strand: '+' | '-', windowLength?: number, sequenceLength?: number, coordinateSystem?: string) {
  if (!Number.isSafeInteger(windowLength) || windowLength! < 1) return null;
  if (strand === '+' || coordinateSystem === 'reference_0based') return { start: start + 1, end: start + windowLength! };
  if (!Number.isSafeInteger(sequenceLength) || sequenceLength! < 1) return null;
  return { start: sequenceLength! - start - windowLength! + 1, end: sequenceLength! - start };
}

export function exportCutoffLabel(summary: JobSummary) {
  if (summary.mode === 'predict' || summary.score_cutoff === null) return 'No export filtering';
  if (summary.score_cutoff === undefined) return 'Not recorded';
  return `Model score ${summary.score_cutoff_operator || '>'} ${summary.score_cutoff}`;
}

export function genomeContextLabel(summary: JobSummary) {
  switch (summary.cgr_source) {
    case 'complete_genome_assembly_fasta': return 'Same as input genome';
    case 'reference_accession': return summary.reference_accession || 'Reference accession not recorded';
    case 'uploaded_complete_genome_fasta': return 'Uploaded complete genome';
    case 'complete_genome_sequence':
    case 'separate_complete_genome_sequence': return 'Separate complete genome';
    default: return 'Not recorded';
  }
}
