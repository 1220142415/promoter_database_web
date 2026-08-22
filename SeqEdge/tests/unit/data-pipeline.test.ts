import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeGff,
  parseFasta,
  parseTaxonomy,
} from '../../scripts/build-gtdb-release.mjs';
import {
  discoverHfBatchInputs,
  hfBatchAssetPaths,
  parseHfInputMapping,
} from '../../scripts/lib/hf-batch-release.mjs';

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'seqedge-data-pipeline-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('GTDB release primitives', () => {
  it('discovers formal HF batches through input_mapping.tsv and fixed asset names', async () => {
    const directory = await temporaryDirectory();
    const batch = join(directory, '000');
    await mkdir(batch);
    await writeFile(join(batch, 'input_mapping.tsv'), [
      'input\taccession',
      'sample-a.fna\tGCA_000411415.1',
      'sample-b.fna\tGCA_000525675.1',
      '',
    ].join('\n'));
    expect(parseHfInputMapping(await readFile(join(batch, 'input_mapping.tsv'), 'utf8'), '000')).toEqual([
      'GCA_000411415.1',
      'GCA_000525675.1',
    ]);
    const discovered = await discoverHfBatchInputs(directory);
    expect(discovered.get('GCA_000411415.1')).toMatchObject({ batch: '000', batchRoot: batch });
    expect(hfBatchAssetPaths(batch, 'GCA_000411415.1')).toEqual({
      fasta: join(batch, 'genomes', 'GCA_000411415.1_genomic.fna.gz'),
      promoters: join(batch, 'promoter_gff', 'GCA_000411415.1.promoters_up80_down20_gt_0.9.gff3'),
      annotations: join(batch, 'ncbi_gff3', 'GCA_000411415.1.genomic.gff3.gz'),
    });
  });

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

  it('accepts formal 100 bp promoters and rejects malformed intervals, strands, and scores', async () => {
    const directory = await temporaryDirectory();
    const valid = join(directory, 'formal.gff3');
    const output = join(directory, 'formal.gff3.gz');
    await writeFile(valid, [
      '##gff-version 3',
      'chr\tRAPPtor\tpromoter\t1\t100\t0.95\t+\t.\tID=p-plus;prediction_score=0.95',
      'chr\tRAPPtor\tpromoter\t101\t200\t0.96\t-\t.\tID=p-minus',
      '',
    ].join('\n'));
    await expect(normalizeGff(valid, output, { expectedType: 'promoter', sequences: new Map([['chr', 200]]) })).resolves.toMatchObject({ featureCount: 2 });

    const malformed = [
      ['length.gff3', 'chr\tRAPPtor\tpromoter\t1\t99\t0.95\t+\t.\tID=p', 'span exactly 100 bp'],
      ['strand.gff3', 'chr\tRAPPtor\tpromoter\t1\t100\t0.95\t.\t.\tID=p', 'strand must be + or -'],
      ['score.gff3', 'chr\tRAPPtor\tpromoter\t1\t100\t0.8\t+\t.\tID=p', 'score is outside'],
    ];
    for (const [name, row, error] of malformed) {
      const source = join(directory, name);
      await writeFile(source, `##gff-version 3\n${row}\n`);
      await expect(normalizeGff(source, join(directory, `${name}.gz`), { expectedType: 'promoter', sequences: new Map([['chr', 200]]) })).rejects.toThrow(error);
    }
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
