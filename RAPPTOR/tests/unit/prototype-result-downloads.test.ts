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
  prototypeResultBedGraph,
  prototypeResultGff3,
} from '@/features/prediction/prototype-result-downloads';

const candidateRun: PrototypePredictionRun = {
  schemaVersion: 3,
  runId: 'prototype_candidate-download-001',
  createdAt: '2026-09-01T00:00:00.000Z',
  mode: 'candidate',
  parameters: { mode: 'candidate', strandMode: 'both', cutoff: .9, strideBases: 1 },
  input: { kind: 'candidate', displayName: 'candidate', format: 'raw', length: 100, checksum: 'a'.repeat(64), sourceKind: 'inline', fileName: null, fileSize: null, genomeContext: PROTOTYPE_CANDIDATE_GENOME_EXAMPLE },
  modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
};

const genomeRun: PrototypePredictionRun = {
  schemaVersion: 3,
  runId: 'prototype_genome-download-001',
  createdAt: '2026-09-01T00:00:00.000Z',
  mode: 'genome-scan',
  parameters: { mode: 'genome-scan', strandMode: 'both', cutoff: .9, strideBases: 1 },
  input: { kind: 'genome-scan', scanSource: PROTOTYPE_GENOME_EXAMPLE, genomeContext: PROTOTYPE_CANDIDATE_GENOME_EXAMPLE },
  modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
};

describe('prototype result downloads', () => {
  it('offers only GFF3 and bedGraph files', () => {
    const fixture = createPrototypeFixture(genomeRun);
    expect(buildPrototypeDownload(genomeRun, fixture, 'gff3').fileName).toBe('rapptor-prototype_genome-download-001.gff3');
    expect(buildPrototypeDownload(genomeRun, fixture, 'bedgraph').fileName).toBe('rapptor-prototype_genome-download-001.bedGraph');
  });

  it('exports focused strand windows in GFF3 and raw anchor scores in bedGraph', () => {
    const fixture = createPrototypeFixture(candidateRun);
    expect(fixture.windows).toHaveLength(2);

    const gffLines = prototypeResultGff3(candidateRun, fixture).trim().split('\n').filter((line) => !line.startsWith('#'));
    expect(gffLines).toHaveLength(2);
    expect(gffLines.every((line) => line.includes('\tfocused_window\t1\t100\t'))).toBe(true);
    expect(gffLines.every((line) => line.includes('cutoff_state='))).toBe(true);
    expect(gffLines.map((line) => line.split('\t')[6])).toEqual(['+', '-']);

    const bedLines = prototypeResultBedGraph(fixture).trim().split('\n').filter((line) => !line.startsWith('track ')).map((line) => line.split('\t'));
    expect(bedLines).toHaveLength(2);
    expect(bedLines.map((columns) => [columns[1], columns[2]])).toEqual([['79', '80'], ['20', '21']]);
    expect(prototypeResultBedGraph(fixture)).toContain('model scores (+)');
    expect(prototypeResultBedGraph(fixture)).toContain('model scores (-)');
  });

  it('exports scan called peaks as 1 bp GFF3 features and raw scores as zero-based bedGraph intervals', () => {
    const fixture = createPrototypeFixture(genomeRun);
    expect(fixture.calledPeaks.length).toBeGreaterThan(0);
    const first = fixture.calledPeaks[0];
    const gffLine = prototypeResultGff3(genomeRun, fixture).split('\n').find((line) => line.includes('\tcalled_peak\t'))!;
    const gffColumns = gffLine.split('\t');
    expect(gffColumns[3]).toBe(String(first.anchor));
    expect(gffColumns[4]).toBe(String(first.anchor));
    expect(gffColumns[5]).toBe(first.smoothedScore.toFixed(6));
    expect(gffColumns[8]).toContain(`window_start_1based=${first.windowStart}`);

    const bedColumns = prototypeResultBedGraph(fixture).trim().split('\n').find((line) => !line.startsWith('track '))!.split('\t');
    expect(Number(bedColumns[2]) - Number(bedColumns[1])).toBe(1);
    expect(Number(bedColumns[3])).toBeGreaterThanOrEqual(0);
    expect(Number(bedColumns[3])).toBeLessThanOrEqual(1);
  });
});
