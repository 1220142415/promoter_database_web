import type {
  DemoGenomeContext,
  DemoPredictionSubmission,
  GenomeContext,
  PredictionCapabilities,
  PredictionSubmission,
  PredictionTicketRequest,
  PredictionUploadRequest,
} from './types';
import { PREDICTION_CONTRACT_VERSION } from './types';

const ACCESSION_PATTERN = /^(?:GCA|GCF)_\d{9}\.\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;

export class PredictionValidationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PredictionValidationError';
    this.code = code;
  }
}

function parseDemoGenomeContext(value: unknown, capabilities: PredictionCapabilities): DemoGenomeContext {
  if (!isRecord(value)) throw new PredictionValidationError('INVALID_GENOME_CONTEXT', 'Genome context is required.');
  if (value.kind === 'catalog') {
    const accession = requiredString(value.accession, 'INVALID_ACCESSION', 'Select a catalog assembly.').toUpperCase();
    if (!ACCESSION_PATTERN.test(accession)) throw new PredictionValidationError('INVALID_ACCESSION', 'Catalog accession is invalid.');
    return {
      kind: 'catalog',
      accession,
      organismName: typeof value.organismName === 'string' ? value.organismName.slice(0, 300) : undefined,
    };
  }
  if (value.kind === 'upload') {
    const fileName = requiredString(value.fileName, 'INVALID_FILE', 'Genome FASTA filename is required.');
    const fileSize = Number(value.fileSize);
    const sha256 = requiredString(value.sha256, 'INVALID_CHECKSUM', 'Genome FASTA SHA-256 is required.').toLowerCase();
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > capabilities.limits.genomeMaxBytes || !SHA256_PATTERN.test(sha256)) {
      throw new PredictionValidationError('INVALID_UPLOAD', 'Genome upload metadata is invalid.');
    }
    if (!/\.(?:fa|fasta|fna)(?:\.gz)?$/i.test(fileName)) {
      throw new PredictionValidationError('INVALID_FILE', 'Genome context must be a FASTA file (.fa, .fasta, .fna, optionally .gz).');
    }
    return { kind: 'upload', fileName, fileSize, sha256 };
  }
  throw new PredictionValidationError('INVALID_GENOME_CONTEXT', 'Choose a catalog assembly or upload a genome FASTA.');
}

export function parseDemoPredictionSubmission(value: unknown, capabilities: PredictionCapabilities): DemoPredictionSubmission {
  if (!isRecord(value) || value.contractVersion !== PREDICTION_CONTRACT_VERSION || !isRecord(value.target)) {
    throw new PredictionValidationError('INVALID_CONTRACT', `Demo prediction submission does not match contractVersion ${PREDICTION_CONTRACT_VERSION}.`);
  }
  if (value.predictionKind !== 'candidate') throw new PredictionValidationError('INVALID_PREDICTION_KIND', 'Only candidate promoter scoring is available.');
  if ('sequence' in value.target) {
    throw new PredictionValidationError('RAW_SEQUENCE_NOT_ALLOWED', 'Demo preview does not accept raw candidate sequence data.');
  }
  const length = Number(value.target.length);
  if (!Number.isSafeInteger(length) || length < capabilities.windowBases || length > capabilities.limits.targetMaxBases) {
    throw new PredictionValidationError('INVALID_TARGET_SIZE', 'Candidate sequence size is outside the accepted limits.');
  }
  const sha256 = requiredString(value.target.sha256, 'INVALID_CHECKSUM', 'Candidate sequence SHA-256 is required.').toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new PredictionValidationError('INVALID_CHECKSUM', 'Candidate sequence SHA-256 is invalid.');
  const format = value.target.format;
  if (format !== 'raw' && format !== 'fasta') throw new PredictionValidationError('INVALID_FORMAT', 'Candidate format must be raw or fasta.');
  const strandMode = value.strandMode;
  if (strandMode !== 'both' && strandMode !== 'forward') throw new PredictionValidationError('INVALID_STRANDS', 'strandMode must be both or forward.');
  return {
    contractVersion: PREDICTION_CONTRACT_VERSION,
    predictionKind: 'candidate',
    target: { format, length, sha256 },
    genomeContext: parseDemoGenomeContext(value.genomeContext, capabilities),
    strandMode,
  };
}

export interface ParsedTargetSequence {
  format: 'raw' | 'fasta';
  sequence: string;
  length: number;
  ambiguousBases: number;
}

export function parseTargetSequence(value: string): ParsedTargetSequence {
  const input = value.trim();
  if (!input) throw new PredictionValidationError('EMPTY_SEQUENCE', 'Enter a DNA sequence or FASTA record.');

  const format = input.startsWith('>') ? 'fasta' : 'raw';
  let sequence: string;

  if (format === 'fasta') {
    const lines = input.split(/\r?\n/);
    let headerCount = 0;
    const bases: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('>')) {
        headerCount += 1;
        if (headerCount > 1) {
          throw new PredictionValidationError('MULTIPLE_FASTA_RECORDS', 'Candidate scoring accepts exactly one FASTA record.');
        }
        continue;
      }
      if (headerCount === 0) {
        throw new PredictionValidationError('INVALID_FASTA', 'FASTA sequence data must follow a header beginning with >.');
      }
      bases.push(line);
    }
    if (headerCount !== 1 || bases.length === 0) {
      throw new PredictionValidationError('INVALID_FASTA', 'FASTA input must contain one header and a DNA sequence.');
    }
    sequence = bases.join('');
  } else {
    sequence = input.replace(/\s+/g, '');
  }

  sequence = sequence.toUpperCase().replaceAll('U', 'T');
  if (!/^[ACGTN]+$/.test(sequence)) {
    throw new PredictionValidationError('INVALID_BASES', 'Only A, C, G, T, U, and N are accepted.');
  }

  return {
    format,
    sequence,
    length: sequence.length,
    ambiguousBases: [...sequence].filter((base) => base === 'N').length,
  };
}

export function validateTargetAgainstCapabilities(parsed: ParsedTargetSequence, capabilities: PredictionCapabilities) {
  if (parsed.length < capabilities.windowBases) {
    throw new PredictionValidationError(
      'SEQUENCE_TOO_SHORT',
      `Candidate sequence must contain at least ${capabilities.windowBases} bases.`,
    );
  }
  if (parsed.length > capabilities.limits.targetMaxBases) {
    throw new PredictionValidationError(
      'SEQUENCE_TOO_LARGE',
      `Candidate sequence exceeds the ${capabilities.limits.targetMaxBases.toLocaleString()} base demo limit.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, code: string, message: string) {
  if (typeof value !== 'string' || !value.trim()) throw new PredictionValidationError(code, message);
  return value.trim();
}

export function parseTicketRequest(value: unknown, capabilities: PredictionCapabilities): PredictionTicketRequest {
  if (!isRecord(value) || value.contractVersion !== PREDICTION_CONTRACT_VERSION) {
    throw new PredictionValidationError('INVALID_CONTRACT', `Prediction contractVersion must be ${PREDICTION_CONTRACT_VERSION}.`);
  }
  const targetBases = Number(value.targetBases);
  const genomeBytes = Number(value.genomeBytes);
  if (!Number.isSafeInteger(targetBases) || targetBases < capabilities.windowBases || targetBases > capabilities.limits.targetMaxBases) {
    throw new PredictionValidationError('INVALID_TARGET_SIZE', 'Candidate sequence size is outside the accepted limits.');
  }
  if (!Number.isSafeInteger(genomeBytes) || genomeBytes < 0 || genomeBytes > capabilities.limits.genomeMaxBytes) {
    throw new PredictionValidationError('INVALID_GENOME_SIZE', 'Genome FASTA size is outside the accepted limits.');
  }
  const modelVersion = requiredString(value.modelVersion, 'INVALID_MODEL', 'modelVersion is required.');
  if (modelVersion !== capabilities.modelVersion) {
    throw new PredictionValidationError('INVALID_MODEL', 'The requested model version is not available.');
  }
  return {
    contractVersion: PREDICTION_CONTRACT_VERSION,
    turnstileToken: requiredString(value.turnstileToken, 'INVALID_TURNSTILE', 'Turnstile verification is required.'),
    modelVersion,
    targetBases,
    genomeBytes,
  };
}

export function parseUploadRequest(value: unknown, capabilities: PredictionCapabilities): PredictionUploadRequest {
  if (!isRecord(value) || value.contractVersion !== PREDICTION_CONTRACT_VERSION) {
    throw new PredictionValidationError('INVALID_CONTRACT', `Prediction contractVersion must be ${PREDICTION_CONTRACT_VERSION}.`);
  }
  const fileName = requiredString(value.fileName, 'INVALID_FILE', 'Genome FASTA filename is required.');
  const fileSize = Number(value.fileSize);
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > capabilities.limits.genomeMaxBytes) {
    throw new PredictionValidationError('INVALID_GENOME_SIZE', 'Genome FASTA size is outside the accepted limits.');
  }
  const sha256 = requiredString(value.sha256, 'INVALID_CHECKSUM', 'Genome FASTA SHA-256 is required.').toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new PredictionValidationError('INVALID_CHECKSUM', 'Genome FASTA SHA-256 is invalid.');
  if (!/\.(?:fa|fasta|fna)(?:\.gz)?$/i.test(fileName)) {
    throw new PredictionValidationError('INVALID_FILE', 'Genome context must be a FASTA file (.fa, .fasta, .fna, optionally .gz).');
  }
  return {
    contractVersion: PREDICTION_CONTRACT_VERSION,
    ticket: requiredString(value.ticket, 'INVALID_TICKET', 'A prediction ticket is required.'),
    fileName,
    fileSize,
    sha256,
  };
}

function parseGenomeContext(value: unknown): GenomeContext {
  if (!isRecord(value)) throw new PredictionValidationError('INVALID_GENOME_CONTEXT', 'Genome context is required.');
  if (value.kind === 'catalog') {
    const accession = requiredString(value.accession, 'INVALID_ACCESSION', 'Select a catalog assembly.').toUpperCase();
    if (!ACCESSION_PATTERN.test(accession)) throw new PredictionValidationError('INVALID_ACCESSION', 'Catalog accession is invalid.');
    return {
      kind: 'catalog',
      accession,
      organismName: typeof value.organismName === 'string' ? value.organismName.slice(0, 300) : undefined,
    };
  }
  if (value.kind === 'upload') {
    const uploadToken = requiredString(value.uploadToken, 'INVALID_UPLOAD', 'Genome upload token is required.');
    if (!TOKEN_PATTERN.test(uploadToken)) throw new PredictionValidationError('INVALID_UPLOAD', 'Genome upload token is invalid.');
    const fileName = requiredString(value.fileName, 'INVALID_FILE', 'Genome FASTA filename is required.');
    const fileSize = Number(value.fileSize);
    const sha256 = requiredString(value.sha256, 'INVALID_CHECKSUM', 'Genome FASTA SHA-256 is required.').toLowerCase();
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || !SHA256_PATTERN.test(sha256)) {
      throw new PredictionValidationError('INVALID_UPLOAD', 'Genome upload metadata is invalid.');
    }
    return { kind: 'upload', uploadToken, fileName, fileSize, sha256 };
  }
  throw new PredictionValidationError('INVALID_GENOME_CONTEXT', 'Choose a catalog assembly or upload a genome FASTA.');
}

export function parsePredictionSubmission(value: unknown, capabilities: PredictionCapabilities): PredictionSubmission {
  if (!isRecord(value) || value.contractVersion !== PREDICTION_CONTRACT_VERSION || !isRecord(value.target)) {
    throw new PredictionValidationError('INVALID_CONTRACT', `Prediction submission does not match contractVersion ${PREDICTION_CONTRACT_VERSION}.`);
  }
  if (value.predictionKind !== 'candidate') throw new PredictionValidationError('INVALID_PREDICTION_KIND', 'Only candidate promoter scoring is available.');
  const targetLength = Number(value.target.length);
  if (!Number.isSafeInteger(targetLength) || targetLength < capabilities.windowBases || targetLength > capabilities.limits.targetMaxBases) {
    throw new PredictionValidationError('INVALID_TARGET_SIZE', 'Candidate sequence size is outside the accepted limits.');
  }
  const sha256 = requiredString(value.target.sha256, 'INVALID_CHECKSUM', 'Candidate sequence SHA-256 is required.').toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new PredictionValidationError('INVALID_CHECKSUM', 'Candidate sequence SHA-256 is invalid.');
  const format = value.target.format;
  if (format !== 'raw' && format !== 'fasta') throw new PredictionValidationError('INVALID_FORMAT', 'Candidate format must be raw or fasta.');
  const strandMode = value.strandMode;
  if (strandMode !== 'both' && strandMode !== 'forward') throw new PredictionValidationError('INVALID_STRANDS', 'strandMode must be both or forward.');
  const modelVersion = requiredString(value.modelVersion, 'INVALID_MODEL', 'modelVersion is required.');
  if (modelVersion !== capabilities.modelVersion) throw new PredictionValidationError('INVALID_MODEL', 'The requested model version is not available.');
  const sequence = typeof value.target.sequence === 'string' ? value.target.sequence : undefined;
  if (capabilities.mode === 'remote' && !sequence) {
    throw new PredictionValidationError('MISSING_SEQUENCE', 'Remote prediction requires the normalized candidate sequence.');
  }
  if (sequence) {
    const parsed = parseTargetSequence(sequence);
    validateTargetAgainstCapabilities(parsed, capabilities);
    if (parsed.length !== targetLength) throw new PredictionValidationError('TARGET_MISMATCH', 'Candidate length metadata does not match its sequence.');
  }
  return {
    contractVersion: PREDICTION_CONTRACT_VERSION,
    predictionKind: 'candidate',
    ticket: requiredString(value.ticket, 'INVALID_TICKET', 'A prediction ticket is required.'),
    modelVersion,
    target: { format, length: targetLength, sha256, sequence },
    genomeContext: parseGenomeContext(value.genomeContext),
    strandMode,
  };
}

export function validJobId(value: string) {
  return /^(?:demo|job)_[A-Za-z0-9_-]{12,128}$/.test(value);
}

export function accessCookieName(jobId: string) {
  return `rapptor_prediction_${jobId}`;
}

export function readCookie(request: Request, name: string) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
