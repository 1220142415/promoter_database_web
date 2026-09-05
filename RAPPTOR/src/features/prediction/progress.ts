import type { PrototypePredictionRun } from './prototype';

export type PredictionProgressState = 'queued' | 'running' | 'succeeded' | 'failed';
export type PredictionProgressMode = 'focused' | 'scan';

export interface PredictionProgressSnapshot {
  state: PredictionProgressState;
  stage: string;
  percent: number | null;
  message: string;
  contig?: string;
  strand?: '+' | '-';
  windows?: number;
  simulated?: boolean;
}

interface TimelineSegment {
  stage: string;
  start: number;
  end: number;
  from: number;
  to: number;
  message: string;
}

const FOCUSED_DURATION_MS = 4_000;
const SCAN_DURATION_MS = 6_000;

const FOCUSED_TIMELINE: TimelineSegment[] = [
  { stage: 'queued', start: 0, end: 600, from: 1, to: 8, message: 'Waiting for an available worker.' },
  { stage: 'preparing_cgr', start: 600, end: 1_500, from: 8, to: 32, message: 'Preparing the illustrative genome CGR.' },
  { stage: 'inference', start: 1_500, end: 3_300, from: 32, to: 88, message: 'Scoring the 100 bp window.' },
  { stage: 'writing_outputs', start: 3_300, end: FOCUSED_DURATION_MS, from: 88, to: 99, message: 'Preparing the result.' },
];

const SCAN_TIMELINE: TimelineSegment[] = [
  { stage: 'queued', start: 0, end: 800, from: 1, to: 8, message: 'Waiting for an available worker.' },
  { stage: 'preparing_cgr', start: 800, end: 1_800, from: 8, to: 22, message: 'Preparing the illustrative genome CGR.' },
  { stage: 'scanning', start: 1_800, end: 5_000, from: 22, to: 88, message: 'Scanning illustrative sequence windows.' },
  { stage: 'writing_outputs', start: 5_000, end: SCAN_DURATION_MS, from: 88, to: 99, message: 'Preparing illustrative browser tracks.' },
];

export function clampPredictionProgress(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

export function normalizePredictionProgress(snapshot: PredictionProgressSnapshot): PredictionProgressSnapshot {
  const percent = snapshot.state === 'succeeded' ? 100 : clampPredictionProgress(snapshot.percent);
  return {
    ...snapshot,
    stage: snapshot.stage.trim().toLowerCase().replaceAll('-', '_') || (snapshot.state === 'queued' ? 'queued' : 'unknown'),
    percent,
  };
}

export function predictionProgressSteps(mode: PredictionProgressMode) {
  return [
    { key: 'queued', label: 'Waiting in queue' },
    { key: 'preparing_cgr', label: 'Preparing genome CGR' },
    { key: 'compute', label: mode === 'focused' ? 'Scoring 100 bp window' : 'Scoring sequence windows' },
    { key: 'writing_outputs', label: mode === 'focused' ? 'Preparing result' : 'Preparing browser tracks' },
    { key: 'complete', label: 'Result ready' },
  ] as const;
}

export function predictionProgressStepIndex(snapshot: PredictionProgressSnapshot) {
  const normalized = normalizePredictionProgress(snapshot);
  if (normalized.state === 'succeeded' || normalized.stage === 'complete') return 4;
  if (normalized.stage === 'writing_outputs' || normalized.stage === 'preparing_result' || normalized.stage === 'preparing_tracks') return 3;
  if (normalized.stage === 'preparing_cgr') return 1;
  if (normalized.stage === 'queued' || normalized.stage === 'starting' || normalized.state === 'queued') return 0;
  return 2;
}

function segmentSnapshot(segment: TimelineSegment, elapsed: number): PredictionProgressSnapshot {
  const fraction = Math.max(0, Math.min(1, (elapsed - segment.start) / Math.max(1, segment.end - segment.start)));
  return {
    state: segment.stage === 'queued' ? 'queued' : 'running',
    stage: segment.stage,
    percent: Number((segment.from + (segment.to - segment.from) * fraction).toFixed(1)),
    message: segment.message,
    simulated: true,
  };
}

function scanDetails(run: Extract<PrototypePredictionRun, { mode: 'genome-scan' }>, elapsed: number) {
  const scanStart = SCAN_TIMELINE[2].start;
  const scanEnd = SCAN_TIMELINE[2].end;
  const fraction = Math.max(0, Math.min(1, (elapsed - scanStart) / (scanEnd - scanStart)));
  const contigs = run.input.scanSource.contigs.filter((contig) => contig.length >= 100);
  const strands = run.parameters.strandMode === 'both' ? (['+', '-'] as const) : (['+'] as const);
  const units = contigs.flatMap((contig) => strands.map((strand) => ({ contig, strand })));
  const unit = units[Math.min(Math.max(0, units.length - 1), Math.floor(fraction * Math.max(1, units.length)))] || null;
  const totalWindows = contigs.reduce((total, contig) => total + Math.max(0, contig.length - 99) * strands.length, 0);
  return {
    contig: unit?.contig.sequenceId,
    strand: unit?.strand,
    windows: Math.min(totalWindows, Math.round(totalWindows * fraction)),
  };
}

export function prototypePredictionProgressAt(run: PrototypePredictionRun, now = Date.now()): PredictionProgressSnapshot {
  const parsedCreatedAt = Date.parse(run.createdAt);
  const elapsed = Math.max(0, now - (Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : now));
  const duration = run.mode === 'candidate' ? FOCUSED_DURATION_MS : SCAN_DURATION_MS;
  if (elapsed >= duration) {
    return {
      state: 'succeeded',
      stage: 'complete',
      percent: 100,
      message: 'Illustrative result is ready.',
      simulated: true,
    };
  }
  const timeline = run.mode === 'candidate' ? FOCUSED_TIMELINE : SCAN_TIMELINE;
  const segment = timeline.find((item) => elapsed < item.end) || timeline[timeline.length - 1];
  const snapshot = segmentSnapshot(segment, elapsed);
  if (run.mode === 'genome-scan' && segment.stage === 'scanning') Object.assign(snapshot, scanDetails(run, elapsed));
  return snapshot;
}
