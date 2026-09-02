export const PROTOTYPE_PREDICTION_SCHEMA_VERSION = 3 as const;
export const PREVIOUS_PROTOTYPE_PREDICTION_SCHEMA_VERSION = 2 as const;
export const LEGACY_PROTOTYPE_PREDICTION_SCHEMA_VERSION = 1 as const;
export const PROTOTYPE_WINDOW_BASES = 100 as const;
export const PROTOTYPE_ANCHOR_BASE = 80 as const;
export const PROTOTYPE_CGR_SIZE = 128 as const;
export const PROTOTYPE_STRIDE_OPTIONS = [1, 5, 10, 20] as const;
export type PrototypeStrideBases = typeof PROTOTYPE_STRIDE_OPTIONS[number];
export const PROTOTYPE_STRIDE_BASES: PrototypeStrideBases = 1;

export type PrototypePredictionMode = 'candidate' | 'genome-scan';
export type PrototypeStrandMode = 'both' | 'forward';
export type PrototypeStrand = '+' | '-';

interface PrototypeBaseParameters {
  strandMode: PrototypeStrandMode;
  cutoff: number;
  strideBases: PrototypeStrideBases;
}

export interface PrototypeCandidateParameters extends PrototypeBaseParameters {
  mode: 'candidate';
}

export interface PrototypeGenomeScanParameters extends PrototypeBaseParameters {
  mode: 'genome-scan';
}

export type PrototypePredictionParameters =
  | PrototypeCandidateParameters
  | PrototypeGenomeScanParameters;

export interface PrototypeContigMetadata {
  sequenceId: string;
  length: number;
}

export type PrototypeGenomeContext =
  | {
      kind: 'catalog';
      accession: string;
      displayName: string;
      fileName: string | null;
      fileSize: number | null;
      checksum: string | null;
      totalLength: number | null;
      contigs: PrototypeContigMetadata[];
    }
  | {
      kind: 'inline';
      displayName: string;
      fileName: null;
      fileSize: null;
      checksum: string;
      totalLength: number;
      contigs: PrototypeContigMetadata[];
    }
  | {
      kind: 'upload';
      displayName: string;
      fileName: string;
      fileSize: number;
      checksum: string;
      totalLength: number | null;
      contigs: PrototypeContigMetadata[];
    };

export interface PrototypeCandidateInput {
  kind: 'candidate';
  displayName: string;
  format: 'raw' | 'fasta';
  length: number;
  checksum: string;
  sourceKind: 'inline' | 'upload';
  fileName: string | null;
  fileSize: number | null;
  genomeContext: PrototypeGenomeContext;
}

export interface PrototypeGenomeScanInput {
  kind: 'genome-scan';
  scanSource: PrototypeGenomeContext;
  genomeContext: PrototypeGenomeContext;
}

export interface PrototypeModelSpec {
  version: string;
  windowBases: typeof PROTOTYPE_WINDOW_BASES;
  anchorBase: typeof PROTOTYPE_ANCHOR_BASE;
  cgrSize: typeof PROTOTYPE_CGR_SIZE;
  strideBases: PrototypeStrideBases;
}

interface PrototypeRunBase {
  schemaVersion: typeof PROTOTYPE_PREDICTION_SCHEMA_VERSION;
  runId: string;
  createdAt: string;
  modelSpec: PrototypeModelSpec;
}

export interface PrototypeCandidateRun extends PrototypeRunBase {
  mode: 'candidate';
  parameters: PrototypeCandidateParameters;
  input: PrototypeCandidateInput;
}

export interface PrototypeGenomeScanRun extends PrototypeRunBase {
  mode: 'genome-scan';
  parameters: PrototypeGenomeScanParameters;
  input: PrototypeGenomeScanInput;
}

export type PrototypePredictionRun = PrototypeCandidateRun | PrototypeGenomeScanRun;

export interface PrototypeWindowParameters {
  strandMode: PrototypeStrandMode;
  cutoff: number;
  strideBases: PrototypeStrideBases;
}

export interface PrototypeScoreWindow {
  sequenceId: string;
  /** One-based inclusive anchor coordinate. */
  anchor: number;
  /** One-based inclusive window start. */
  windowStart: number;
  /** One-based inclusive window end. */
  windowEnd: number;
  strand: PrototypeStrand;
  score: number;
  parameters: PrototypeWindowParameters;
}

export interface PrototypeCalledPeak extends PrototypeScoreWindow {
  rawScore: number;
  smoothedScore: number;
}

export interface PrototypePredictionFixture {
  runId: string;
  mode: PrototypePredictionMode;
  windows: PrototypeScoreWindow[];
  scoreSeries: PrototypeScoreWindow[];
  calledPeaks: PrototypeCalledPeak[];
}

export const DEFAULT_PROTOTYPE_MODEL_SPEC: PrototypeModelSpec = {
  version: 'rapptor-cgr-100bp-prototype-v1',
  windowBases: PROTOTYPE_WINDOW_BASES,
  anchorBase: PROTOTYPE_ANCHOR_BASE,
  cgrSize: PROTOTYPE_CGR_SIZE,
  strideBases: PROTOTYPE_STRIDE_BASES,
};
