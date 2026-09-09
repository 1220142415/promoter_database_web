import reference from './examples/ecoli-k12.json' with { type: 'json' };
import uploadReference from './examples/ecoli-k12-upload.json' with { type: 'json' };

export const REAL_PREDICTION_REFERENCE = reference;
export const UPLOAD_PREDICTION_REFERENCE = uploadReference;

export function predictionReferenceExample(accession: string) {
  return [reference, uploadReference].find((example) => example.accession === accession);
}
export const REAL_CANDIDATE_FASTA = `>${reference.sequenceId}:${reference.sample.start}-${reference.sample.end}:+\n${reference.sample.sequence}`;
export const REAL_GENOME_CONTEXT = {
  kind: 'catalog' as const,
  accession: reference.accession,
  displayName: reference.organism,
  fileName: reference.fileName,
  fileSize: null,
  checksum: reference.fastaSha256,
  totalLength: reference.length,
  contigs: [{ sequenceId: reference.sequenceId, length: reference.length }],
};

export async function referenceSha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Validate original FASTA bytes, reference identity, and the exact sample coordinate. */
export async function validateReferenceExample(fasta: string, expected = reference) {
  if (await referenceSha256(fasta) !== expected.fastaSha256) throw new Error('Reference FASTA checksum mismatch.');
  const lines = fasta.split(/\r?\n/);
  const headers = lines.filter((line) => line.startsWith('>'));
  if (headers.length !== 1 || headers[0].slice(1).split(/\s/)[0] !== expected.sequenceId) throw new Error('Reference sequence ID does not match the example.');
  const sequence = lines.filter((line) => !line.startsWith('>')).join('').replace(/\s/g, '').toUpperCase();
  if (sequence.length !== expected.length || !/^[ACGT]+$/.test(sequence)) throw new Error('Reference sequence length or alphabet is invalid.');
  if (await referenceSha256(sequence) !== expected.sequenceSha256) throw new Error('Reference sequence checksum mismatch.');
  const sample = sequence.slice(expected.sample.start - 1, expected.sample.end);
  if (sample.length !== 100 || sample !== expected.sample.sequence || await referenceSha256(sample) !== expected.sample.sha256) throw new Error('The 100 bp example does not match its reference coordinates.');
  return { fasta, sequence, sample, sequenceId: expected.sequenceId, length: sequence.length };
}
