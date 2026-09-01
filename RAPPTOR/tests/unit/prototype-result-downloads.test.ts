import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTOTYPE_MODEL_SPEC,
  PROTOTYPE_CANDIDATE_GENOME_EXAMPLE,
  PROTOTYPE_GENOME_EXAMPLE,
  createPrototypeFixture,
  type PrototypePredictionRun,
} from '@/features/prediction/prototype';
import {
  buildPrototypeDownload,
  prototypeResultBed6,
  prototypeResultGff3,
  prototypeResultJson,
  prototypeResultTsv,
} from '@/features/prediction/prototype-result-downloads';

const candidateRun: PrototypePredictionRun = {
  schemaVersion: 2,
  runId: 'prototype_candidate-download-001',
  createdAt: '2026-09-01T00:00:00.000Z',
  mode: 'candidate',
  parameters: { mode: 'candidate', strandMode: 'both', cutoff: .9 },
  input: { kind: 'candidate', displayName: 'candidate', format: 'raw', length: 100, checksum: 'a'.repeat(64), sourceKind: 'inline', fileName: null, fileSize: null, genomeContext: PROTOTYPE_CANDIDATE_GENOME_EXAMPLE },
  modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
};

const genomeRun: PrototypePredictionRun = {
  schemaVersion: 2,
  runId: 'prototype_genome-download-001',
  createdAt: '2026-09-01T00:00:00.000Z',
  mode: 'genome-scan',
  parameters: { mode: 'genome-scan', strandMode: 'both', cutoff: .9, topK: 10 },
  input: { kind: 'genome-scan', genomeContext: PROTOTYPE_GENOME_EXAMPLE },
  modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
};

describe('prototype result downloads', () => {
  it('labels fixture JSON and never exports raw inputs or hidden peak settings', () => {
    const fixture = createPrototypeFixture(genomeRun);
    const json = prototypeResultJson(genomeRun, fixture);
    expect(json).toContain('No model was run');
    expect(json).toContain('"peakCalling": "backend-managed"');
    expect(json).not.toMatch(/sigma|minDistance|sequence\s*:/i);
    expect(buildPrototypeDownload(genomeRun, fixture, 'json').fileName).toBe('rapptor-prototype_genome-download-001.json');
  });

  it('exports focused scores per strand without ranking or scan-only fields', () => {
    const fixture = createPrototypeFixture(candidateRun);
    const json = prototypeResultJson(candidateRun, fixture);
    const tsv = prototypeResultTsv(candidateRun, fixture);
    expect(fixture.windows).toHaveLength(2);
    expect(json).not.toMatch(/topK|topWindows|calledPeaks/);
    expect(tsv).toContain('raw_score\tcutoff\tcutoff_state\tanchor_1based');
    expect(tsv).not.toMatch(/rank|smoothed_score|called-peak/);
    expect(tsv.trim().split('\n')).toHaveLength(3);

    const gffLines = prototypeResultGff3(candidateRun, fixture).trim().split('\n').filter((line) => !line.startsWith('#'));
    expect(gffLines).toHaveLength(2);
    expect(gffLines.every((line) => line.includes('\tfocused_window\t1\t100\t'))).toBe(true);
    expect(gffLines.every((line) => line.includes('cutoff_state='))).toBe(true);

    const bedLines = prototypeResultBed6(candidateRun, fixture).trim().split('\n').map((line) => line.split('\t'));
    expect(bedLines).toHaveLength(2);
    expect(bedLines.every((columns) => columns[1] === '0' && columns[2] === '100')).toBe(true);
  });

  it('exports called peaks as 1 bp anchors in GFF3 and BED6', () => {
    const fixture = createPrototypeFixture(genomeRun);
    expect(fixture.calledPeaks.length).toBeGreaterThan(0);
    const first = fixture.calledPeaks[0];
    const gffLine = prototypeResultGff3(genomeRun, fixture).split('\n').find((line) => line.includes('\tcalled_peak\t'))!;
    const gffColumns = gffLine.split('\t');
    expect(gffColumns[3]).toBe(String(first.anchor));
    expect(gffColumns[4]).toBe(String(first.anchor));
    expect(gffColumns[5]).toBe(first.smoothedScore.toFixed(6));
    expect(gffColumns[8]).toContain(`window_start_1based=${first.windowStart}`);

    const bedColumns = prototypeResultBed6(genomeRun, fixture).trim().split('\n')[0].split('\t');
    expect(Number(bedColumns[2]) - Number(bedColumns[1])).toBe(1);
    expect(bedColumns[4]).toBe(String(Math.round(first.smoothedScore * 1000)));
  });
});
