/**
 * User-facing RAPPTOR terminology.
 *
 * This module is display-only. Do not use these values for API fields,
 * serialized output, storage keys, or evidence/coordinate calculations.
 */

export const PORTAL_TERMS = {
  brand: 'RAPPTOR',
  modelScore: 'Model score',
  rawModelScores: 'Raw model scores',
  highestModelScore: 'Highest model score',
  modelScoreByAnchor: 'Model score by anchor',
  modelThreshold: 'Model threshold',
  exportCutoff: 'Export cutoff',
  scoring100Bp: '100 bp scoring',
  sequenceScan: 'Sequence scan',
  genomeContextCgr: 'Genome context (CGR)',
  stride: 'Stride',
  illustrativePeaks: 'Illustrative peaks',
  promoterPredictions: 'Promoter predictions',
  studies: 'Studies',
  observations: 'Observations',
  generated: 'Generated',
  genomeSummary: 'Genome summary',
  openBrowser: 'Open browser',
  preparingBrowser: 'Preparing browser',
  browserUnavailable: 'Browser unavailable',
} as const;

export type PortalPredictionMode = 'candidate' | 'genome-scan' | 'genome_scan' | 'predict';

export function predictionModeLabel(mode: PortalPredictionMode) {
  if (mode === 'candidate') return PORTAL_TERMS.scoring100Bp;
  if (mode === 'genome-scan' || mode === 'genome_scan') return PORTAL_TERMS.sequenceScan;
  return 'Target sequence';
}

export function thresholdLabel(mode: PortalPredictionMode | 'release') {
  return mode === 'genome-scan' || mode === 'genome_scan' ? PORTAL_TERMS.exportCutoff : PORTAL_TERMS.modelThreshold;
}

export const PORTAL_COPY = {
  homeLead: 'Genome-resolved promoter predictions, reference assemblies, and NCBI annotations.',
  prototypeHeading: 'Add input. RAPPTOR selects the analysis.',
  prototypeModeHelp: 'A single 100 bp record is scored as a focused window. Longer sequences and genomes use a sequence scan.',
  predictionRule: 'Promoter predictions use model score > 0.9.',
  demoNotice: 'Demo only: deterministic fixture values; no model was run.',
  focusedThresholdHelp: 'Classifies the result only; the model score is unchanged.',
  genomeScanCutoffHelp: 'Filters sparse output only; score tracks are unchanged.',
  noAssemblies: 'No assemblies found. Try accession, organism, or strain.',
  catalogUnavailable: 'Genome catalog unavailable.',
  biologicalMatchUnavailable: 'The match is not biologically verified.',
  cyanobacteriaSummary: 'Three genomes with RAPPTOR promoter predictions and genome annotations.',
  studyBoundary: 'Study-level TSS under the reported conditions; not universal promoter validation.',
} as const;
