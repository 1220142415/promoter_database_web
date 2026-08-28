export const PREDICTION_CONTRACT_VERSION = 2 as const;
export const PREDICTION_WINDOW_BASES = 100 as const;
export const PREDICTION_ANCHOR_BASE = 80 as const;
export const PREDICTION_DOWNSTREAM_BASES = PREDICTION_WINDOW_BASES - PREDICTION_ANCHOR_BASE;

export function predictionAnchorCoordinate(windowStart: number, strand: '+' | '-') {
  return strand === '+'
    ? windowStart + PREDICTION_ANCHOR_BASE - 1
    : windowStart + PREDICTION_WINDOW_BASES - PREDICTION_ANCHOR_BASE;
}

export type PredictionServiceMode = 'demo' | 'remote';
export type PredictionServiceStatus = 'demo' | 'ready' | 'unavailable';
export type PredictionJobState = 'queued' | 'running' | 'succeeded' | 'failed';
export type PredictionStrandMode = 'both' | 'forward';
export type PredictionKind = 'candidate';

export interface PredictionCapabilities {
  contractVersion: typeof PREDICTION_CONTRACT_VERSION;
  available: boolean;
  mode: PredictionServiceMode;
  serviceStatus: PredictionServiceStatus;
  demoPreviewAvailable: boolean;
  modelVersion: string;
  supportedPredictionKinds: PredictionKind[];
  windowBases: number;
  predictionAnchorBase: number;
  promoterThreshold: number;
  acceptedTargetFormats: string[];
  acceptedGenomeFormats: string[];
  limits: {
    targetMaxBases: number;
    genomeMaxBytes: number;
  };
  retention: {
    inputHours: number;
    resultDays: number;
  };
  turnstileSiteKey: string | null;
  unavailableReason?: string;
}

export type DemoGenomeContext =
  | {
      kind: 'catalog';
      accession: string;
      organismName?: string;
    }
  | {
      kind: 'upload';
      fileName: string;
      fileSize: number;
      sha256: string;
    };

export interface DemoPredictionSubmission {
  contractVersion: typeof PREDICTION_CONTRACT_VERSION;
  predictionKind: PredictionKind;
  target: {
    format: 'raw' | 'fasta';
    length: number;
    sha256: string;
  };
  genomeContext: DemoGenomeContext;
  strandMode: PredictionStrandMode;
}

export type GenomeContext =
  | {
      kind: 'catalog';
      accession: string;
      organismName?: string;
    }
  | {
      kind: 'upload';
      uploadToken: string;
      fileName: string;
      fileSize: number;
      sha256: string;
    };

export interface PredictionSubmission {
  contractVersion: typeof PREDICTION_CONTRACT_VERSION;
  predictionKind: PredictionKind;
  ticket: string;
  modelVersion: string;
  target: {
    format: 'raw' | 'fasta';
    length: number;
    sha256: string;
    sequence?: string;
  };
  genomeContext: GenomeContext;
  strandMode: PredictionStrandMode;
}

export interface PredictionTicketRequest {
  contractVersion: typeof PREDICTION_CONTRACT_VERSION;
  turnstileToken: string;
  modelVersion: string;
  targetBases: number;
  genomeBytes: number;
}

export interface PredictionTicketResponse {
  contractVersion: typeof PREDICTION_CONTRACT_VERSION;
  ticket: string;
  expiresAt: string;
}

export interface PredictionUploadRequest {
  contractVersion: typeof PREDICTION_CONTRACT_VERSION;
  ticket: string;
  fileName: string;
  fileSize: number;
  sha256: string;
}

export interface PredictionUploadSlot {
  contractVersion: typeof PREDICTION_CONTRACT_VERSION;
  uploadToken: string;
  uploadRequired: boolean;
  uploadUrl: string | null;
  method: 'PUT' | null;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface PredictionJob {
  contractVersion: typeof PREDICTION_CONTRACT_VERSION;
  predictionKind: PredictionKind;
  jobId: string;
  state: PredictionJobState;
  progress: number;
  modelVersion: string;
  createdAt: string;
  updatedAt: string;
  resultAvailable: boolean;
  demo: boolean;
  message: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface PredictionScorePoint {
  windowStart: number;
  plus: number;
  minus: number | null;
}

export interface PredictionWindowResult {
  rank: number;
  probability: number;
  strand: '+' | '-';
  promoterStart: number;
  promoterEnd: number;
}

export interface PredictionBrowserAssets {
  assemblyName: string;
  defaultLocus: string;
  expiresAt: string;
  reference: {
    fastaUrl: string;
    faiUrl: string;
    gziUrl: string;
  };
  scores: {
    plusBigWigUrl: string;
    minusBigWigUrl: string | null;
  };
  promoters: {
    gff3Url: string;
    indexUrl: string;
  };
}

export interface PredictionResult {
  contractVersion: typeof PREDICTION_CONTRACT_VERSION;
  predictionKind: PredictionKind;
  jobId: string;
  demo: boolean;
  modelVersion: string;
  probabilityThreshold: number;
  highestProbability: number;
  bestWindow: {
    promoterStart: number;
    promoterEnd: number;
    strand: '+' | '-';
  };
  call: 'model-positive-candidate' | 'below-model-threshold';
  input: {
    length: number;
    sha256: string;
    strandMode: PredictionStrandMode;
  };
  genomeContext: {
    kind: GenomeContext['kind'];
    label: string;
    sha256: string;
    cgrConverterVersion: string;
  };
  scoreSeries: PredictionScorePoint[];
  topWindows: PredictionWindowResult[];
  browserAssets?: PredictionBrowserAssets;
  completedAt: string;
}

export interface PredictionApiError {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}
