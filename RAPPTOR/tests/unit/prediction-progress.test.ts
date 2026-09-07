import { describe, expect, it } from 'vitest';
import {
  clampPredictionProgress,
  normalizePredictionProgress,
  predictionProgressStepIndex,
  prototypePredictionProgressAt,
} from '@/features/prediction/progress';
import {
  DEFAULT_PROTOTYPE_MODEL_SPEC,
  PROTOTYPE_CANDIDATE_GENOME_EXAMPLE,
  type PrototypePredictionRun,
} from '@/features/prediction/prototype';

const createdAt = '2026-09-02T00:00:00.000Z';
const start = Date.parse(createdAt);

const focusedRun: PrototypePredictionRun = {
  schemaVersion: 3,
  runId: 'prototype_progress-focused',
  createdAt,
  mode: 'candidate',
  parameters: { mode: 'candidate', strandMode: 'both', cutoff: .9, strideBases: 1 },
  input: {
    kind: 'candidate', displayName: 'candidate', format: 'raw', length: 100, checksum: 'a'.repeat(64),
    sourceKind: 'inline', fileName: null, fileSize: null, genomeContext: PROTOTYPE_CANDIDATE_GENOME_EXAMPLE,
  },
  modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
};

const scanRun: PrototypePredictionRun = {
  schemaVersion: 3,
  runId: 'prototype_progress-scan',
  createdAt,
  mode: 'genome-scan',
  parameters: { mode: 'genome-scan', strandMode: 'both', cutoff: .9, strideBases: 1 },
  input: { kind: 'genome-scan', scanSource: PROTOTYPE_CANDIDATE_GENOME_EXAMPLE, genomeContext: PROTOTYPE_CANDIDATE_GENOME_EXAMPLE },
  modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
};

describe('prediction progress', () => {
  it('advances the focused prototype monotonically and completes after four seconds', () => {
    const snapshots = [0, 700, 1_700, 3_500, 4_000].map((elapsed) => prototypePredictionProgressAt(focusedRun, start + elapsed));
    expect(snapshots.map((item) => item.stage)).toEqual(['queued', 'preparing_cgr', 'inference', 'writing_outputs', 'complete']);
    expect(snapshots.map((item) => item.percent)).toEqual([...snapshots].map((item) => item.percent).sort((a, b) => Number(a) - Number(b)));
    expect(snapshots.at(-1)).toMatchObject({ state: 'succeeded', percent: 100, simulated: true });
  });

  it('reports scan details and completes after six seconds without restarting from createdAt', () => {
    const scanning = prototypePredictionProgressAt(scanRun, start + 3_000);
    expect(scanning).toMatchObject({ state: 'running', stage: 'scanning', contig: 'NC_000913.3', strand: expect.stringMatching(/[+-]/) });
    expect(scanning.windows).toBeGreaterThan(0);
    expect(prototypePredictionProgressAt(scanRun, start + 5_300).stage).toBe('writing_outputs');
    expect(prototypePredictionProgressAt(scanRun, start + 60_000)).toMatchObject({ state: 'succeeded', stage: 'complete', percent: 100 });
  });

  it('clamps service percentages and maps unknown running stages to the compute step', () => {
    expect(clampPredictionProgress(-3)).toBe(0);
    expect(clampPredictionProgress(104)).toBe(100);
    expect(clampPredictionProgress(undefined)).toBeNull();
    const unknown = normalizePredictionProgress({ state: 'running', stage: 'custom-worker-stage', percent: 140, message: 'Running.' });
    expect(unknown.percent).toBe(100);
    expect(predictionProgressStepIndex(unknown)).toBe(2);
  });
});
