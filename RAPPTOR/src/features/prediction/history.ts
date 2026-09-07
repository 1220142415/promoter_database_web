export type PredictionHistoryStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';

export type PredictionHistoryEntry = {
  jobId: string;
  token: string;
  refName: string;
  status: PredictionHistoryStatus;
  mode: 'genome_scan' | 'predict';
  submittedAt: string;
  label: string;
  bases: number;
  cutoff?: number;
  strandMode?: 'both' | 'forward';
  strideBases?: number;
};

export const PREDICTION_HISTORY_KEY = 'rapptor-prediction-history';
const HISTORY_LIMIT = 20;
const JOB_ID = /^[0-9a-f]{32}$/;
const STATUSES = new Set<PredictionHistoryStatus>(['queued', 'running', 'succeeded', 'failed', 'unknown']);

function isEntry(value: unknown): value is PredictionHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<PredictionHistoryEntry>;
  return typeof entry.jobId === 'string' && JOB_ID.test(entry.jobId)
    && typeof entry.token === 'string' && entry.token.length > 0 && entry.token.length <= 200
    && typeof entry.refName === 'string'
    && typeof entry.status === 'string' && STATUSES.has(entry.status as PredictionHistoryStatus)
    && (entry.mode === 'genome_scan' || entry.mode === 'predict')
    && typeof entry.submittedAt === 'string'
    && typeof entry.label === 'string'
    && typeof entry.bases === 'number' && Number.isSafeInteger(entry.bases) && entry.bases >= 0
    && (entry.cutoff === undefined || (typeof entry.cutoff === 'number' && entry.cutoff >= 0 && entry.cutoff <= 1))
    && (entry.strandMode === undefined || entry.strandMode === 'both' || entry.strandMode === 'forward')
    && (entry.strideBases === undefined || (Number.isSafeInteger(entry.strideBases) && entry.strideBases > 0));
}

export function parsePredictionHistory(raw: string | null) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function upsertPredictionHistory(current: PredictionHistoryEntry[], entry: PredictionHistoryEntry) {
  return [entry, ...current.filter((item) => item.jobId !== entry.jobId)].slice(0, HISTORY_LIMIT);
}
