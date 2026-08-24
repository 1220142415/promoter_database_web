import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeGff,
  parseFasta,
  parseTaxonomy,
} from '../../scripts/build-gtdb-release.mjs';

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'rapptor-data-pipeline-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('GTDB release primitives', () => {
  it('parses all seven GTDB taxonomy ranks without inventing missing names', () => {
    expect(parseTaxonomy('d__Bacteria;p__Bacillota;c__Bacilli;o__;f__;g__;s__', 'GCA_000000001.1')).toMatchObject({
      domain: 'Bacteria',
      phylum: 'Bacillota',
      className: 'Bacilli',
      order: null,
      species: null,
    });
    expect(() => parseTaxonomy('d__Bacteria;p__Bacillota', 'GCA_000000001.1')).toThrow('seven GTDB taxonomy ranks');
  });

  it('computes FASTA length, GC, contigs, and rejects duplicate sequence names', async () => {
    const directory = await temporaryDirectory();
    const fasta = join(directory, 'reference.fa.gz');
    await writeFile(fasta, gzipSync('>chr\nACGTNN\n>plasmid\nGGCC\n'));
    await expect(parseFasta(fasta)).resolves.toMatchObject({ genomeSizeBp: 10, gcContent: 60, contigCount: 2, primarySequence: 'chr' });

    const duplicate = join(directory, 'duplicate.fa.gz');
    await writeFile(duplicate, gzipSync('>chr\nACGT\n>chr duplicate\nACGT\n'));
    await expect(parseFasta(duplicate)).rejects.toThrow('duplicate FASTA sequence name chr');
  });

  it('keeps valid promoter points in 1-based GFF3 and blocks out-of-range predictions', async () => {
    const directory = await temporaryDirectory();
    const valid = join(directory, 'valid.gff3');
    const output = join(directory, 'valid.gff3.gz');
    await writeFile(valid, '##gff-version 3\nchr\tRAPPtor\tpromoter_peak\t5\t5\t0.95\t+\t.\tID=p1;prediction_score=0.95\n');
    await expect(normalizeGff(valid, output, { expectedType: 'promoter_peak', sequences: new Map([['chr', 10]]) })).resolves.toMatchObject({ featureCount: 1 });
    expect(gunzipSync(await readFile(output)).toString()).toContain('\t5\t5\t0.95\t+\t.\t');

    const invalid = join(directory, 'invalid.gff3');
    await writeFile(invalid, '##gff-version 3\nchr\tRAPPtor\tpromoter_peak\t11\t11\t0.95\t+\t.\tID=p2;prediction_score=0.95\n');
    await expect(normalizeGff(invalid, join(directory, 'invalid.gz'), { expectedType: 'promoter_peak', sequences: new Map([['chr', 10]]) })).rejects.toThrow('coordinate exceeds FASTA');
  });

  it('normalizes supported circular-origin features without truncating their identity', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'ncbi.gff3');
    await writeFile(source, [
      '##gff-version 3',
      '##sequence-region chr 1 100',
      'chr\tNCBI\tregion\t1\t100\t.\t+\t.\tID=chr;Is_circular=true',
      'chr\tNCBI\tgene\t90\t110\t.\t+\t.\tID=gene-1',
      'chr\tNCBI\tCDS\t90\t110\t.\t+\t0\tID=cds-1;Parent=gene-1',
      '',
    ].join('\n'));
    const output = join(directory, 'ncbi.gz');
    await expect(normalizeGff(source, output, { sequences: new Map([['chr', 100]]) })).resolves.toMatchObject({
      featureCount: 3,
      normalizedFeatureCount: 5,
      circularOriginSplitCount: 2,
    });
    const normalized = gunzipSync(await readFile(output)).toString();
    expect(normalized).toContain('chr\tNCBI\tgene\t1\t10\t.\t+\t.\tID=gene-1');
    expect(normalized).toContain('chr\tNCBI\tgene\t90\t100\t.\t+\t.\tID=gene-1');
    expect(normalized).toContain('chr\tNCBI\tCDS\t1\t10\t.\t+\t1\tID=cds-1;Parent=gene-1');
  });
});
