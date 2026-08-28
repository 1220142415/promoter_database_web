import { describe, expect, it } from 'vitest';
import { PREDICTION_CONTRACT_VERSION, predictionAnchorCoordinate, type PredictionCapabilities } from '@/features/prediction/types';
import {
  parseDemoPredictionSubmission,
  parsePredictionSubmission,
  parseTargetSequence,
  PredictionValidationError,
  validateTargetAgainstCapabilities,
} from '@/features/prediction/validation';
import { normalizeStoredPredictionSubmission, topPromoterWindows } from '@/features/prediction/demo-provider';

const capabilities: PredictionCapabilities = {
  contractVersion: PREDICTION_CONTRACT_VERSION,
  available: true,
  mode: 'demo',
  serviceStatus: 'demo',
  demoPreviewAvailable: true,
  modelVersion: 'test-model',
  supportedPredictionKinds: ['candidate'],
  windowBases: 100,
  predictionAnchorBase: 80,
  promoterThreshold: .9,
  acceptedTargetFormats: ['raw DNA', 'FASTA'],
  acceptedGenomeFormats: ['.fa'],
  limits: { targetMaxBases: 1_000, genomeMaxBytes: 10_000 },
  retention: { inputHours: 24, resultDays: 7 },
  turnstileSiteKey: null,
};

describe('prediction input validation', () => {
  it('normalizes raw sequence whitespace, case, and U', () => {
    expect(parseTargetSequence('acgu\nNN')).toEqual({ format: 'raw', sequence: 'ACGTNN', length: 6, ambiguousBases: 2 });
  });

  it('parses exactly one FASTA record', () => {
    expect(parseTargetSequence('>candidate description\nacgt\nTGCA')).toEqual({ format: 'fasta', sequence: 'ACGTTGCA', length: 8, ambiguousBases: 0 });
    expect(() => parseTargetSequence('>one\nACGT\n>two\nTGCA')).toThrowError(expect.objectContaining({ code: 'MULTIPLE_FASTA_RECORDS' }));
  });

  it('rejects unsupported bases and enforces the model window and service maximum', () => {
    expect(() => parseTargetSequence('ACGT-X')).toThrowError(expect.objectContaining({ code: 'INVALID_BASES' }));
    expect(() => validateTargetAgainstCapabilities(parseTargetSequence('A'.repeat(99)), capabilities)).toThrowError(expect.objectContaining({ code: 'SEQUENCE_TOO_SHORT' }));
    expect(() => validateTargetAgainstCapabilities(parseTargetSequence('A'.repeat(1_001)), capabilities)).toThrowError(expect.objectContaining({ code: 'SEQUENCE_TOO_LARGE' }));
    expect(() => validateTargetAgainstCapabilities(parseTargetSequence('A'.repeat(100)), capabilities)).not.toThrow();
  });

  it('requires exactly one valid genome context and preserves demo privacy', () => {
    const submission = parsePredictionSubmission({
      contractVersion: PREDICTION_CONTRACT_VERSION,
      predictionKind: 'candidate',
      ticket: 'ticket_example_abcdefghijklmnop',
      modelVersion: 'test-model',
      target: { format: 'raw', length: 100, sha256: 'a'.repeat(64) },
      genomeContext: { kind: 'catalog', accession: 'gca_000411415.1', organismName: 'Test organism' },
      strandMode: 'both',
    }, capabilities);
    expect(submission.target.sequence).toBeUndefined();
    expect(submission.genomeContext).toMatchObject({ kind: 'catalog', accession: 'GCA_000411415.1' });

    expect(() => parsePredictionSubmission({
      ...submission,
      genomeContext: { kind: 'catalog', accession: 'not-an-accession' },
    }, capabilities)).toThrowError(PredictionValidationError);
  });

  it('requires normalized sequence content in remote mode', () => {
    expect(() => parsePredictionSubmission({
      contractVersion: PREDICTION_CONTRACT_VERSION,
      predictionKind: 'candidate',
      ticket: 'ticket_example_abcdefghijklmnop',
      modelVersion: 'test-model',
      target: { format: 'raw', length: 100, sha256: 'b'.repeat(64) },
      genomeContext: { kind: 'catalog', accession: 'GCF_000007325.1' },
      strandMode: 'forward',
    }, { ...capabilities, mode: 'remote', serviceStatus: 'ready', turnstileSiteKey: 'site' })).toThrowError(expect.objectContaining({ code: 'MISSING_SEQUENCE' }));
  });

  it('accepts metadata-only demo submissions and rejects raw sequence transmission', () => {
    const value = {
      contractVersion: PREDICTION_CONTRACT_VERSION,
      predictionKind: 'candidate',
      target: { format: 'raw', length: 100, sha256: 'c'.repeat(64) },
      genomeContext: { kind: 'upload', fileName: 'genome.fna.gz', fileSize: 1_024, sha256: 'd'.repeat(64) },
      strandMode: 'both',
    };
    expect(parseDemoPredictionSubmission(value, capabilities)).toMatchObject({ predictionKind: 'candidate', target: { length: 100 }, genomeContext: { kind: 'upload', fileName: 'genome.fna.gz' } });
    expect(() => parseDemoPredictionSubmission({ ...value, target: { ...value.target, sequence: 'A'.repeat(100) } }, capabilities)).toThrowError(expect.objectContaining({ code: 'RAW_SEQUENCE_NOT_ALLOWED' }));
  });

  it('reports first, last, and reverse-strand results as inclusive promoter windows', () => {
    expect(topPromoterWindows([
      { windowStart: 1, plus: .95, minus: .2 },
      { windowStart: 901, plus: .3, minus: .97 },
    ])).toEqual([
      { rank: 1, probability: .97, strand: '-', promoterStart: 901, promoterEnd: 1000 },
      { rank: 2, probability: .95, strand: '+', promoterStart: 1, promoterEnd: 100 },
      { rank: 3, probability: .3, strand: '+', promoterStart: 901, promoterEnd: 1000 },
      { rank: 4, probability: .2, strand: '-', promoterStart: 1, promoterEnd: 100 },
    ]);
    expect(predictionAnchorCoordinate(1, '+')).toBe(80);
    expect(predictionAnchorCoordinate(9, '+')).toBe(88);
    expect(predictionAnchorCoordinate(901, '+')).toBe(980);
    expect(predictionAnchorCoordinate(1, '-')).toBe(21);
    expect(predictionAnchorCoordinate(901, '-')).toBe(921);
  });

  it('normalizes stored v1 demo submissions without exposing the legacy coordinate contract', () => {
    const normalized = normalizeStoredPredictionSubmission({
      contractVersion: 1,
      ticket: 'consumed',
      modelVersion: 'test-model',
      target: { format: 'raw', length: 100, sha256: 'f'.repeat(64) },
      genomeContext: { kind: 'catalog', accession: 'GCA_000411415.1' },
      strandMode: 'both',
    });
    expect(normalized).toMatchObject({ contractVersion: PREDICTION_CONTRACT_VERSION, predictionKind: 'candidate' });
  });
});
