import {
  PROTOTYPE_STRIDE_BASES,
  PROTOTYPE_STRIDE_OPTIONS,
  type PrototypePredictionMode,
  type PrototypeCandidateParameters,
  type PrototypeGenomeScanParameters,
  type PrototypePredictionParameters,
  type PrototypeStrandMode,
  type PrototypeStrideBases,
} from './types';

export const PROTOTYPE_CANDIDATE_MIN_BASES = 100 as const;
export const PROTOTYPE_INLINE_MAX_BASES = 10_000 as const;
export const PROTOTYPE_GENOME_MAX_BYTES = 12 * 1024 * 1024;
export const PROTOTYPE_GENOME_FILE_PATTERN = /\.(?:fa|fasta|fna)(?:\.gz)?$/i;

export class PrototypeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrototypeValidationError';
  }
}

export function prototypeParameters(mode: 'candidate', strandMode: PrototypeStrandMode, cutoff: number, strideBases?: number): PrototypeCandidateParameters;
export function prototypeParameters(mode: 'genome-scan', strandMode: PrototypeStrandMode, cutoff: number, strideBases?: number): PrototypeGenomeScanParameters;
export function prototypeParameters(mode: PrototypePredictionMode, strandMode: PrototypeStrandMode, cutoff: number, strideBases?: number): PrototypePredictionParameters;
export function prototypeParameters(
  mode: PrototypePredictionMode,
  strandMode: PrototypeStrandMode,
  cutoff: number,
  strideBases: number = PROTOTYPE_STRIDE_BASES,
): PrototypePredictionParameters {
  if (strandMode !== 'both' && strandMode !== 'forward') {
    throw new PrototypeValidationError('Choose a supported strand option.');
  }
  if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 1) {
    throw new PrototypeValidationError('Score cutoff must be between 0 and 1.');
  }
  if (!PROTOTYPE_STRIDE_OPTIONS.includes(strideBases as PrototypeStrideBases)) {
    throw new PrototypeValidationError('Choose a supported scan stride.');
  }
  const base = { strandMode, cutoff: Math.round(cutoff * 100) / 100, strideBases: strideBases as PrototypeStrideBases };
  return { mode, ...base };
}

export function validatePrototypeCandidateLength(length: number) {
  if (length !== PROTOTYPE_CANDIDATE_MIN_BASES) {
    throw new PrototypeValidationError('Focused candidate scoring requires exactly one 100 bp sequence.');
  }
}

export function validatePrototypeInlineLength(length: number) {
  if (!Number.isSafeInteger(length) || length > PROTOTYPE_INLINE_MAX_BASES) {
    throw new PrototypeValidationError(
      `Pasted sequence input must contain ${PROTOTYPE_INLINE_MAX_BASES.toLocaleString()} bases or fewer. Upload a FASTA for longer input.`,
    );
  }
}

export function validatePrototypeGenomeFile(file: Pick<File, 'name' | 'size'>) {
  if (!PROTOTYPE_GENOME_FILE_PATTERN.test(file.name)) {
    throw new PrototypeValidationError('Choose a .fa, .fasta, or .fna file, optionally gzip-compressed.');
  }
  if (file.size <= 0) throw new PrototypeValidationError('Genome FASTA is empty.');
  if (file.size > PROTOTYPE_GENOME_MAX_BYTES) {
    throw new PrototypeValidationError('Genome FASTA must be 12 MiB or smaller.');
  }
}

export function formatPrototypeBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
