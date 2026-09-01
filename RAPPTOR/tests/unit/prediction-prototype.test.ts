// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTOTYPE_MODEL_SPEC,
  callPrototypePeaks,
  createPrototypeFixture,
  legacyPrototypeRunStorageKey,
  parsePrototypeGenomeFastaMetadata,
  parsePrototypeSequenceInput,
  prototypeParameters,
  prototypeRunStorageKey,
  readPrototypePredictionRun,
  serializePrototypePredictionRun,
  validatePrototypeCandidateLength,
  validatePrototypeGenomeFile,
  validatePrototypeInlineLength,
  type PrototypeCandidateRun,
  type PrototypeGenomeScanRun,
  type PrototypeScoreWindow,
} from '@/features/prediction/prototype';

const baseRun: PrototypeCandidateRun = {
  schemaVersion: 2,
  runId: 'prototype_123456789abc',
  createdAt: '2026-09-01T00:00:00.000Z',
  mode: 'candidate',
  parameters: { mode: 'candidate', strandMode: 'both', cutoff: 0.9 },
  modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
  input: {
    kind: 'candidate', displayName: 'candidate_1', format: 'raw', length: 100,
    checksum: 'a'.repeat(64), sourceKind: 'inline', fileName: null, fileSize: null,
    genomeContext: {
      kind: 'upload', displayName: 'context.fna', fileName: 'context.fna', fileSize: 200,
      checksum: 'b'.repeat(64), totalLength: 120, contigs: [{ sequenceId: 'contig_1', length: 120 }],
    },
  },
};

function scoreWindow(score: number): PrototypeScoreWindow {
  return {
    sequenceId: 'contig_1', anchor: 80, windowStart: 1, windowEnd: 100, strand: '+', score,
    parameters: { strandMode: 'forward', cutoff: 0.9, topK: null },
  };
}

describe('prediction prototype core', () => {
  it('infers focused only for one exactly-100bp record and scan for longer valid input', () => {
    expect(parsePrototypeSequenceInput('ACGT'.repeat(25)).mode).toBe('candidate');
    expect(parsePrototypeSequenceInput('ACGT'.repeat(26)).mode).toBe('genome-scan');
    const mixed = parsePrototypeSequenceInput(`>long\n${'ACGT'.repeat(30)}\n>short\n${'ACGT'.repeat(10)}`);
    expect(mixed.mode).toBe('genome-scan');
    expect(mixed.validContigs).toHaveLength(1);
    expect(mixed.skippedContigs).toHaveLength(1);
    expect(() => parsePrototypeSequenceInput(`>a\n${'ACGT'.repeat(15)}\n>b\n${'ACGT'.repeat(15)}`)).toThrow('at least one contig');
  });

  it('uses a strict score greater-than cutoff boundary', () => {
    expect(callPrototypePeaks([scoreWindow(0.9)], 0.9)).toHaveLength(0);
    expect(callPrototypePeaks([scoreWindow(0.901)], 0.9)).toHaveLength(1);
  });

  it('retains one representative when illustrative local maxima are clustered', () => {
    const clustered = [0.8, 1, 0.8, 1, 0.8].map((score, index) => ({ ...scoreWindow(score), anchor: 80 + index * 2, windowStart: 1 + index * 2, windowEnd: 100 + index * 2 }));
    expect(callPrototypePeaks(clustered, 0.85)).toHaveLength(1);
  });

  it('keeps deterministic raw scores independent of cutoff', () => {
    const lower = createPrototypeFixture({ ...baseRun, parameters: prototypeParameters('candidate', 'both', 0.5) });
    const higher = createPrototypeFixture({ ...baseRun, parameters: prototypeParameters('candidate', 'both', 0.95) });
    expect(lower.windows.map((window) => window.score)).toEqual(higher.windows.map((window) => window.score));
  });

  it('gives the built-in-sized scan fixture called peaks at the default cutoff', () => {
    const scanRun: PrototypeGenomeScanRun = {
      schemaVersion: 2, runId: 'prototype_scan12345678', createdAt: baseRun.createdAt,
      mode: 'genome-scan', modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
      parameters: prototypeParameters('genome-scan', 'both', 0.9, 10),
      input: { kind: 'genome-scan', genomeContext: { kind: 'inline', displayName: 'Pasted sequence', fileName: null, fileSize: null, checksum: 'c'.repeat(64), totalLength: 300, contigs: [{ sequenceId: 'inline_contig_1', length: 160 }, { sequenceId: 'inline_contig_2', length: 140 }] } },
    };
    expect(createPrototypeFixture(scanRun).calledPeaks.length).toBeGreaterThan(0);
  });

  it('serializes v2 metadata with an explicit allowlist and excludes raw input fields', () => {
    const unsafeRun = structuredClone(baseRun) as PrototypeCandidateRun & { sequence?: string; fasta?: string };
    unsafeRun.sequence = 'TOP_SECRET_SEQUENCE';
    unsafeRun.fasta = 'TOP_SECRET_FASTA';
    unsafeRun.input.displayName = 'TOP_SECRET_FASTA_HEADER';
    unsafeRun.input.genomeContext.contigs[0].sequenceId = 'TOP_SECRET_CONTIG_HEADER';
    Object.assign(unsafeRun.input, { sequence: 'TOP_SECRET_INPUT' });
    Object.assign(unsafeRun.input.genomeContext, { fasta: 'TOP_SECRET_GENOME' });
    const serialized = serializePrototypePredictionRun(unsafeRun);
    expect(serialized).toContain('"schemaVersion":2');
    expect(serialized).not.toContain('TOP_SECRET');
    expect(serialized).not.toContain('"sequence"');
    expect(serialized).not.toContain('"fasta"');
    expect(serialized).not.toContain('"topK"');
  });

  it('reads a long legacy v1 candidate as a v2 scan because mode is now inferred by length', () => {
    const legacy = {
      ...baseRun,
      schemaVersion: 1,
      parameters: { ...baseRun.parameters, topK: 10 },
      input: { ...baseRun.input, length: 448, sourceKind: undefined, fileName: undefined, fileSize: undefined },
    };
    sessionStorage.setItem(legacyPrototypeRunStorageKey(baseRun.runId), JSON.stringify(legacy));
    const restored = readPrototypePredictionRun(baseRun.runId);
    expect(restored).toMatchObject({
      schemaVersion: 2,
      mode: 'genome-scan',
      parameters: { cutoff: 0.9, topK: 10 },
      input: { kind: 'genome-scan', genomeContext: { kind: 'inline', totalLength: 448 } },
    });
    sessionStorage.clear();
  });

  it('rejects malformed v2 runs and strips unknown fields when restoring metadata', () => {
    const stored = JSON.parse(serializePrototypePredictionRun(baseRun));
    stored.input.sequence = 'INJECTED_SEQUENCE';
    sessionStorage.setItem(prototypeRunStorageKey(baseRun.runId), JSON.stringify(stored));
    expect(readPrototypePredictionRun(baseRun.runId)).not.toHaveProperty('input.sequence');
    stored.parameters.cutoff = 2;
    sessionStorage.setItem(prototypeRunStorageKey(baseRun.runId), JSON.stringify(stored));
    expect(readPrototypePredictionRun(baseRun.runId)).toBeNull();
    sessionStorage.clear();
  });

  it('extracts context contig ids and lengths without retaining FASTA sequence', () => {
    expect(parsePrototypeGenomeFastaMetadata('>chr one\nACGTNN\n>plasmid\nACGT')).toEqual([{ sequenceId: 'chr', length: 6 }, { sequenceId: 'plasmid', length: 4 }]);
  });

  it('validates mode-specific parameters and input boundaries', () => {
    expect(prototypeParameters('candidate', 'both', 0.9)).toEqual({ mode: 'candidate', strandMode: 'both', cutoff: 0.9 });
    expect(prototypeParameters('genome-scan', 'forward', 0.9, 10)).toEqual({ mode: 'genome-scan', strandMode: 'forward', cutoff: 0.9, topK: 10 });
    expect(() => prototypeParameters('candidate', 'both', Number.NaN)).toThrow('between 0 and 1');
    expect(() => prototypeParameters('genome-scan', 'both', 0.9, 7)).toThrow('5, 10, or 20');
    expect(() => validatePrototypeCandidateLength(100)).not.toThrow();
    expect(() => validatePrototypeCandidateLength(101)).toThrow('exactly one 100 bp');
    expect(() => validatePrototypeInlineLength(10_000)).not.toThrow();
    expect(() => validatePrototypeInlineLength(10_001)).toThrow('10,000 bases or fewer');
    expect(() => validatePrototypeGenomeFile({ name: 'genome.fna.gz', size: 50 * 1024 * 1024 })).not.toThrow();
    expect(() => validatePrototypeGenomeFile({ name: 'annotations.gff3', size: 500 })).toThrow('.fa, .fasta, or .fna');
  });
});
