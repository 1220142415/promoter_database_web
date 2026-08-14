import { describe, expect, it } from 'vitest';
import { firstFastaRefName, maybeDecompressGzip } from '@/lib/on-demand-genome-assets';

describe('on-demand genome assets', () => {
  it('reads the first FASTA reference name', () => {
    expect(firstFastaRefName('>NC_000001.1 description\nACGT\n')).toBe('NC_000001.1');
    expect(firstFastaRefName('not fasta')).toBeNull();
  });

  it('leaves an uncompressed blob unchanged', async () => {
    const blob = new Blob(['>contig\nACGT\n'], { type: 'text/plain' });
    await expect(maybeDecompressGzip(blob)).resolves.toBe(blob);
  });
});
