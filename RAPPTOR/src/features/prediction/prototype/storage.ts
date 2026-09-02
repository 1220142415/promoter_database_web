import {
  LEGACY_PROTOTYPE_PREDICTION_SCHEMA_VERSION,
  PREVIOUS_PROTOTYPE_PREDICTION_SCHEMA_VERSION,
  PROTOTYPE_ANCHOR_BASE,
  PROTOTYPE_CGR_SIZE,
  PROTOTYPE_PREDICTION_SCHEMA_VERSION,
  PROTOTYPE_STRIDE_BASES,
  PROTOTYPE_STRIDE_OPTIONS,
  PROTOTYPE_WINDOW_BASES,
  type PrototypeGenomeContext,
  type PrototypePredictionRun,
} from './types';

const PROTOTYPE_RUN_STORAGE_PREFIX = 'rapptor:prediction-prototype:v3:';
const PREVIOUS_PROTOTYPE_RUN_STORAGE_PREFIX = 'rapptor:prediction-prototype:v2:';
const LEGACY_PROTOTYPE_RUN_STORAGE_PREFIX = 'rapptor:prediction-prototype:v1:';
const PROTOTYPE_RUN_ID_PATTERN = /^prototype_[a-z0-9-]{12,80}$/;

export function createPrototypeRunId() {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `prototype_${randomPart.toLowerCase()}`;
}

export function prototypeRunStorageKey(runId: string) {
  if (!PROTOTYPE_RUN_ID_PATTERN.test(runId)) throw new Error('Prototype run id is invalid.');
  return `${PROTOTYPE_RUN_STORAGE_PREFIX}${runId}`;
}

export function legacyPrototypeRunStorageKey(runId: string) {
  if (!PROTOTYPE_RUN_ID_PATTERN.test(runId)) throw new Error('Prototype run id is invalid.');
  return `${LEGACY_PROTOTYPE_RUN_STORAGE_PREFIX}${runId}`;
}

export function previousPrototypeRunStorageKey(runId: string) {
  if (!PROTOTYPE_RUN_ID_PATTERN.test(runId)) throw new Error('Prototype run id is invalid.');
  return `${PREVIOUS_PROTOTYPE_RUN_STORAGE_PREFIX}${runId}`;
}

function cleanGenomeContext(context: PrototypeGenomeContext): PrototypeGenomeContext {
  const contigPrefix = context.kind === 'catalog' ? null : context.kind === 'inline' ? 'inline_contig' : 'uploaded_contig';
  const shared = {
    displayName: context.kind === 'inline' ? 'Pasted sequence' : context.displayName,
    fileName: context.fileName,
    fileSize: context.fileSize,
    checksum: context.checksum,
    totalLength: context.totalLength,
    contigs: context.contigs.map(({ sequenceId, length }, index) => ({ sequenceId: contigPrefix ? `${contigPrefix}_${index + 1}` : sequenceId, length })),
  };
  if (context.kind === 'catalog') return { kind: 'catalog', accession: context.accession, ...shared };
  if (context.kind === 'inline') return { kind: 'inline', ...shared, fileName: null, fileSize: null, checksum: context.checksum, totalLength: context.totalLength };
  return { kind: 'upload', ...shared, fileName: context.fileName, fileSize: context.fileSize, checksum: context.checksum };
}

/** Serializes an explicit metadata allowlist. Raw DNA, FASTA text, and File objects are never copied. */
export function serializePrototypePredictionRun(run: PrototypePredictionRun) {
  const parameters = { mode: run.mode, strandMode: run.parameters.strandMode, cutoff: run.parameters.cutoff, strideBases: run.parameters.strideBases };
  const base = {
    schemaVersion: PROTOTYPE_PREDICTION_SCHEMA_VERSION,
    runId: run.runId,
    createdAt: run.createdAt,
    mode: run.mode,
    parameters,
    modelSpec: {
      version: run.modelSpec.version,
      windowBases: run.modelSpec.windowBases,
      anchorBase: run.modelSpec.anchorBase,
      cgrSize: run.modelSpec.cgrSize,
      strideBases: run.parameters.strideBases,
    },
  };
  const input = run.mode === 'candidate'
    ? {
        kind: 'candidate' as const,
        displayName: 'candidate_sequence',
        format: run.input.format,
        length: run.input.length,
        checksum: run.input.checksum,
        sourceKind: run.input.sourceKind,
        fileName: run.input.fileName,
        fileSize: run.input.fileSize,
        genomeContext: cleanGenomeContext(run.input.genomeContext),
      }
    : {
        kind: 'genome-scan' as const,
        scanSource: cleanGenomeContext(run.input.scanSource),
        genomeContext: cleanGenomeContext(run.input.genomeContext),
      };
  return JSON.stringify({ ...base, input });
}

export function writePrototypePredictionRun(run: PrototypePredictionRun, storage: Storage = window.sessionStorage) {
  storage.setItem(prototypeRunStorageKey(run.runId), serializePrototypePredictionRun(run));
}

export function readPrototypePredictionRun(runId: string, storage: Storage = window.sessionStorage): PrototypePredictionRun | null {
  let raw: string | null = null;
  let storedVersion: 1 | 2 | 3 = 3;
  try {
    raw = storage.getItem(prototypeRunStorageKey(runId));
    if (!raw) {
      raw = storage.getItem(previousPrototypeRunStorageKey(runId));
      storedVersion = raw ? 2 : 1;
    }
    if (!raw) {
      raw = storage.getItem(legacyPrototypeRunStorageKey(runId));
      storedVersion = 1;
    }
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    const migrated = storedVersion === 1
      ? migrateLegacyRun(value)
      : storedVersion === 2
        ? migratePreviousRun(value)
        : value;
    const normalized = normalizeStrideMetadata(migrated);
    return isPrototypePredictionRun(normalized)
      ? JSON.parse(serializePrototypePredictionRun(normalized)) as PrototypePredictionRun
      : null;
  } catch {
    return null;
  }
}

export function removePrototypePredictionRun(runId: string, storage: Storage = window.sessionStorage) {
  storage.removeItem(prototypeRunStorageKey(runId));
  storage.removeItem(previousPrototypeRunStorageKey(runId));
  storage.removeItem(legacyPrototypeRunStorageKey(runId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStrideMetadata(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.parameters) || !isRecord(value.modelSpec)) return value;
  const strideBases = value.parameters.strideBases === undefined
    ? PROTOTYPE_STRIDE_BASES
    : value.parameters.strideBases;
  return {
    ...value,
    parameters: { ...value.parameters, strideBases },
    modelSpec: { ...value.modelSpec, strideBases },
  };
}

function migratePreviousRun(value: unknown): unknown {
  if (!isRecord(value) || value.schemaVersion !== PREVIOUS_PROTOTYPE_PREDICTION_SCHEMA_VERSION || !isRecord(value.parameters) || !isRecord(value.input)) return null;
  if (value.mode === 'candidate') {
    return {
      ...value,
      schemaVersion: PROTOTYPE_PREDICTION_SCHEMA_VERSION,
      parameters: { mode: 'candidate', strandMode: value.parameters.strandMode, cutoff: value.parameters.cutoff },
    };
  }
  if (value.mode === 'genome-scan' && isGenomeContext(value.input.genomeContext)) {
    return {
      ...value,
      schemaVersion: PROTOTYPE_PREDICTION_SCHEMA_VERSION,
      parameters: { mode: 'genome-scan', strandMode: value.parameters.strandMode, cutoff: value.parameters.cutoff },
      input: {
        kind: 'genome-scan',
        scanSource: value.input.genomeContext,
        genomeContext: value.input.genomeContext,
      },
    };
  }
  return null;
}

function migrateLegacyRun(value: unknown): unknown {
  if (!isRecord(value) || value.schemaVersion !== LEGACY_PROTOTYPE_PREDICTION_SCHEMA_VERSION || !isRecord(value.parameters) || !isRecord(value.input)) return null;
  if (value.mode === 'candidate') {
    if (!Number.isSafeInteger(value.input.length) || Number(value.input.length) < PROTOTYPE_WINDOW_BASES || Number(value.input.length) > 10_000 || typeof value.input.checksum !== 'string') return null;
    const length = Number(value.input.length);
    if (length !== PROTOTYPE_WINDOW_BASES) {
      return {
        ...value,
        schemaVersion: PROTOTYPE_PREDICTION_SCHEMA_VERSION,
        mode: 'genome-scan',
        parameters: { mode: 'genome-scan', strandMode: value.parameters.strandMode, cutoff: value.parameters.cutoff },
        input: {
          kind: 'genome-scan',
          scanSource: {
            kind: 'inline',
            displayName: 'Pasted sequence',
            fileName: null,
            fileSize: null,
            checksum: value.input.checksum,
            totalLength: length,
            contigs: [{ sequenceId: 'inline_contig_1', length }],
          },
          genomeContext: isGenomeContext(value.input.genomeContext)
            ? value.input.genomeContext
            : {
                kind: 'inline',
                displayName: 'Pasted sequence',
                fileName: null,
                fileSize: null,
                checksum: value.input.checksum,
                totalLength: length,
                contigs: [{ sequenceId: 'inline_contig_1', length }],
              },
        },
      };
    }
    return {
      ...value,
      schemaVersion: PROTOTYPE_PREDICTION_SCHEMA_VERSION,
      parameters: { mode: 'candidate', strandMode: value.parameters.strandMode, cutoff: value.parameters.cutoff },
      input: { ...value.input, sourceKind: 'inline', fileName: null, fileSize: null },
    };
  }
  if (value.mode === 'genome-scan') {
    if (!isGenomeContext(value.input.genomeContext)) return null;
    return {
      ...value,
      schemaVersion: PROTOTYPE_PREDICTION_SCHEMA_VERSION,
      parameters: { mode: 'genome-scan', strandMode: value.parameters.strandMode, cutoff: value.parameters.cutoff },
      input: {
        kind: 'genome-scan',
        scanSource: value.input.genomeContext,
        genomeContext: value.input.genomeContext,
      },
    };
  }
  return null;
}

function isGenomeContext(value: unknown): value is PrototypeGenomeContext {
  if (!isRecord(value) || !['catalog', 'upload', 'inline'].includes(String(value.kind))) return false;
  if (typeof value.displayName !== 'string' || !nullableString(value.fileName) || !nullableSafeInteger(value.fileSize) || !nullableString(value.checksum) || !nullableSafeInteger(value.totalLength) || !Array.isArray(value.contigs)) return false;
  if (!value.contigs.every((contig) => isRecord(contig) && typeof contig.sequenceId === 'string' && Number.isSafeInteger(contig.length) && Number(contig.length) > 0)) return false;
  if (value.kind === 'catalog') return typeof value.accession === 'string';
  if (value.kind === 'inline') return value.fileName === null && value.fileSize === null && typeof value.checksum === 'string' && Number.isSafeInteger(value.totalLength);
  return typeof value.fileName === 'string' && Number.isSafeInteger(value.fileSize) && Number(value.fileSize) > 0 && typeof value.checksum === 'string';
}

function nullableString(value: unknown) { return value === null || typeof value === 'string'; }
function nullableSafeInteger(value: unknown) { return value === null || (Number.isSafeInteger(value) && Number(value) >= 0); }

function hasValidParameters(value: Record<string, unknown>, mode: unknown) {
  const shared = value.mode === mode
    && (value.strandMode === 'both' || value.strandMode === 'forward')
    && typeof value.cutoff === 'number'
    && Number.isFinite(value.cutoff)
    && value.cutoff >= 0
    && value.cutoff <= 1
    && typeof value.strideBases === 'number'
    && PROTOTYPE_STRIDE_OPTIONS.includes(value.strideBases as (typeof PROTOTYPE_STRIDE_OPTIONS)[number]);
  return shared;
}

function hasValidModelSpec(value: Record<string, unknown>) {
  return typeof value.version === 'string'
    && value.windowBases === PROTOTYPE_WINDOW_BASES
    && value.anchorBase === PROTOTYPE_ANCHOR_BASE
    && value.cgrSize === PROTOTYPE_CGR_SIZE
    && typeof value.strideBases === 'number'
    && PROTOTYPE_STRIDE_OPTIONS.includes(value.strideBases as (typeof PROTOTYPE_STRIDE_OPTIONS)[number]);
}

function isPrototypePredictionRun(value: unknown): value is PrototypePredictionRun {
  if (!isRecord(value) || value.schemaVersion !== PROTOTYPE_PREDICTION_SCHEMA_VERSION) return false;
  if (typeof value.runId !== 'string' || !PROTOTYPE_RUN_ID_PATTERN.test(value.runId) || typeof value.createdAt !== 'string') return false;
  if (!isRecord(value.parameters) || !hasValidParameters(value.parameters, value.mode) || !isRecord(value.modelSpec) || !hasValidModelSpec(value.modelSpec) || value.modelSpec.strideBases !== value.parameters.strideBases || !isRecord(value.input)) return false;
  if (value.mode === 'candidate') {
    return value.input.kind === 'candidate'
      && typeof value.input.displayName === 'string'
      && (value.input.format === 'raw' || value.input.format === 'fasta')
      && value.input.length === PROTOTYPE_WINDOW_BASES
      && typeof value.input.checksum === 'string'
      && (value.input.sourceKind === 'inline' || value.input.sourceKind === 'upload')
      && nullableString(value.input.fileName)
      && nullableSafeInteger(value.input.fileSize)
      && isGenomeContext(value.input.genomeContext);
  }
  return value.mode === 'genome-scan'
    && value.input.kind === 'genome-scan'
    && isGenomeContext(value.input.scanSource)
    && isGenomeContext(value.input.genomeContext);
}
