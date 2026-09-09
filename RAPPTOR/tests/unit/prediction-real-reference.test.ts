import { describe, expect, it } from 'vitest';
import { REAL_PREDICTION_REFERENCE as reference, referenceSha256, validateReferenceExample } from '@/features/prediction/reference-example';
import { parseFocusedScores } from '@/features/prediction/focused-scores';

// Small fixture tests the validator in CI; the pinned 4.6 Mb reference is verified by the explicit live command.
async function fixture() {
  const sequence = reference.sample.sequence;
  const fasta = `>${reference.sequenceId}\n${sequence}\n`;
  const expected = { ...reference, length: 100, fastaSha256: await referenceSha256(fasta), sequenceSha256: await referenceSha256(sequence), sample: { ...reference.sample, start: 1, end: 100 } };
  return { sequence, fasta, expected };
}

describe('reference integrity and coordinate validation', () => {
  it('checks the public 100 bp sample checksum and extracts 1-based inclusive coordinates', async () => {
    expect(await referenceSha256(reference.sample.sequence)).toBe(reference.sample.sha256);
    const { fasta, expected, sequence } = await fixture();
    expect((await validateReferenceExample(fasta, expected)).sample).toBe(sequence);
    expect(reference.sample.end - reference.sample.start + 1).toBe(100);
  });
  it('rejects changed original FASTA bytes even when sequence content is unchanged', async () => {
    const { fasta, expected } = await fixture();
    await expect(validateReferenceExample(fasta.replaceAll('\n', '\r\n'), expected)).rejects.toThrow('FASTA checksum');
  });
  it.each(['id', 'length', 'sequence', 'coordinate', 'sample'] as const)('rejects an inconsistent %s', async (field) => {
    const { fasta, expected } = await fixture();
    if (field === 'id') expected.sequenceId = 'NC_000913.3';
    if (field === 'length') expected.length = 101;
    if (field === 'sequence') expected.sequenceSha256 = '0'.repeat(64);
    if (field === 'coordinate') expected.sample.start = 2;
    if (field === 'sample') expected.sample.sha256 = '0'.repeat(64);
    await expect(validateReferenceExample(fasta, expected)).rejects.toThrow();
  });
});

describe('real score artifact validation', () => {
  const plus = { strand: '+', score: .37, window_start_0based: 0, anchor_position_0based: 79 };
  const minus = { strand: '-', score: .62, window_start_0based: 0, anchor_position_0based: 20 };
  it('preserves the supplied scores and orders both strands', () => {
    expect(parseFocusedScores([minus, plus])).toEqual([plus, minus]);
    expect(parseFocusedScores([plus], false)).toEqual([plus]);
  });
  it.each([[plus], [plus, plus], [plus, { ...minus, score: NaN }], [plus, { ...minus, score: 1.1 }], [plus, { ...minus, window_start_0based: 1 }], [plus, { ...minus, anchor_position_0based: 100 }]])('rejects missing or invalid output: %j', (...rows) => {
    expect(() => parseFocusedScores(rows)).toThrow();
  });
});
