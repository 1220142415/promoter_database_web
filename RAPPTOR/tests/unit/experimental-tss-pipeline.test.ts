import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildExperimentalD1Sql,
  buildExperimentalRelease,
  datasetReportMetadata,
  enrichPubmed,
  observationsToGff3,
  parseExperimentalBed,
  parseExperimentalManifest,
  sortGff3TextForTabix,
  validateExperimentalRelease,
} from '../../scripts/huggingface/lib/experimental-tss-release.mjs';

const gzip = promisify(gzipCallback);
const temporary: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'seqedge-experimental-tss-'));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(text: string | Buffer) {
  return createHash('sha256').update(text).digest('hex');
}

function study(overrides: Record<string, unknown> = {}) {
  return {
    studyId: '2020_12345678_GCF_000000001.1',
    datasetRow: 1,
    accession: 'GCF_000000001.1',
    pmid: '12345678',
    year: 2020,
    sourceFile: '2020-Nature-GCF_000000001.1.bed',
    sourceSha256: 'a'.repeat(64),
    outputFile: '2020_12345678_GCF_000000001.1.bed',
    recordCount: 3,
    ...overrides,
  };
}

describe('experimental TSS release pipeline', () => {
  it('parses the strict manifest and verifies all aggregate dimensions', async () => {
    const root = await tempRoot();
    const bed = 'GCF_000000001.1:chr\t1\t2\tgene\tdescription\t+\n';
    await writeFile(join(root, 'one.bed'), bed);
    await writeFile(join(root, 'manifest.tsv'), [
      'study_id\tdataset_row\tgcf\tpmid\tsource_file\tsource_sha256\toutput_file\trecord_count',
      `2020_12345678_GCF_000000001.1\t1\tGCF_000000001.1\t12345678\toriginal.bed\t${sha256(bed)}\tone.bed\t1`,
      '',
    ].join('\n'));

    const parsed = await parseExperimentalManifest(root, {
      expected: { studies: 1, genomes: 1, publications: 1, observations: 1 },
    });
    expect(parsed.rows[0]).toMatchObject({ studyId: '2020_12345678_GCF_000000001.1', year: 2020, recordCount: 1 });
    expect(parsed.summary).toEqual({ studies: 1, genomes: 1, publications: 1, observations: 1 });
    await expect(parseExperimentalManifest(root)).rejects.toThrow('studies mismatch');
  });

  it('converts every BED row one-to-one and preserves exact duplicate provenance', () => {
    const bed = [
      'GCF_000000001.1:chr\t4\t5\tgene A\t5UTR\t+',
      'GCF_000000001.1:chr\t4\t5\tgene A\t5UTR\t+',
      'GCF_000000001.1:chr\t9\t10\tgene B\t.\t-',
      '',
    ].join('\n');
    const parsed = parseExperimentalBed(bed, study(), new Map([['chr', 10]]));
    expect(parsed.observations).toHaveLength(3);
    expect(parsed.observations[0]).toMatchObject({ id: '2020_12345678_GCF_000000001.1:1', start: 5, end: 5 });
    expect(parsed.observations[1].id.endsWith(':2')).toBe(true);
    expect(parsed.duplicateGroupCount).toBe(1);
    expect(parsed.duplicateObservationCount).toBe(2);
    const gff = observationsToGff3(parsed, study());
    expect(gff.match(/\texperimental_tss\t/g)).toHaveLength(3);
    expect(gff).toContain('raw_row=1');
    expect(gff).toContain('duplicate_count=2');
    expect(gff).toContain('chr\tRAPPTOR\texperimental_tss\t5\t5\t.\t+');
  });

  it.each([
    ['wrong column count', 'GCF_000000001.1:chr\t1\t2\tname\t+'],
    ['wrong accession prefix', 'GCF_999999999.1:chr\t1\t2\tname\t.\t+'],
    ['not one base', 'GCF_000000001.1:chr\t1\t3\tname\t.\t+'],
    ['invalid strand', 'GCF_000000001.1:chr\t1\t2\tname\t.\t.'],
    ['unknown contig', 'GCF_000000001.1:other\t1\t2\tname\t.\t+'],
    ['outside reference', 'GCF_000000001.1:chr\t10\t11\tname\t.\t+'],
  ])('rejects %s', (_label, row) => {
    expect(() => parseExperimentalBed(`${row}\n`, study({ recordCount: 1 }), new Map([['chr', 10]]))).toThrow();
  });

  it('uses cached PubMed metadata and records a non-blocking network fallback', async () => {
    const root = await tempRoot();
    const cachePath = join(root, 'pubmed.json');
    await writeFile(cachePath, JSON.stringify({
      12345678: { title: 'Mapped starts', authors: ['A. Author'], journal: 'Journal', doi: '10.1/test' },
    }));
    const result = await enrichPubmed(['12345678', '87654321'], {
      cachePath,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    expect(result.publications.get('12345678')).toMatchObject({ title: 'Mapped starts', status: 'resolved' });
    expect(result.publications.get('87654321')).toMatchObject({ status: 'unavailable' });
    expect(result.warnings).toEqual([expect.stringContaining('87654321')]);
  });

  it('normalizes camelCase NCBI package metadata and sorts annotation rows for tabix', () => {
    expect(datasetReportMetadata({
      accession: 'GCF_000009725.1',
      organism: { organismName: 'Synechocystis sp. PCC 6803', infraspecificNames: { strain: 'PCC 6803' } },
      assemblyInfo: {
        assemblyName: 'ASM972v1', assemblyLevel: 'Complete Genome',
        pairedAssembly: { accession: 'GCA_000009725.1' },
      },
    }, 'GCF_000009725.1')).toEqual({
      organismName: 'Synechocystis sp. PCC 6803', strain: 'PCC 6803',
      assemblyName: 'ASM972v1', assemblyLevel: 'Complete Genome',
      genbankAssemblyAccession: 'GCA_000009725.1', refseqAssemblyAccession: 'GCF_000009725.1',
    });

    const sorted = sortGff3TextForTabix([
      '##gff-version 3',
      'chr2\tNCBI\tgene\t20\t25\t.\t+\t.\tID=b',
      'chr1\tNCBI\tgene\t30\t35\t.\t+\t.\tID=c',
      'chr1\tNCBI\tgene\t10\t15\t.\t+\t.\tID=a',
      '##FASTA',
      '>chr1',
      'ACGT',
      '',
    ].join('\n'));
    expect(sorted).toBe([
      '##gff-version 3',
      'chr1\tNCBI\tgene\t10\t15\t.\t+\t.\tID=a',
      'chr1\tNCBI\tgene\t30\t35\t.\t+\t.\tID=c',
      'chr2\tNCBI\tgene\t20\t25\t.\t+\t.\tID=b',
      '',
    ].join('\n'));
  });

  it('builds a self-contained subset release, D1 import, and validates checksums', async () => {
    const root = await tempRoot();
    const sourceRoot = join(root, 'source');
    const ncbiRoot = join(root, 'ncbi');
    const output = join(root, 'release');
    const accession = 'GCF_000000001.1';
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(ncbiRoot, accession), { recursive: true });
    const bed1 = `${accession}:chr\t1\t2\tgene A\t.\t+\n${accession}:chr\t1\t2\tgene A\t.\t+\n`;
    const bed2 = `${accession}:chr\t9\t10\tgene B\tprimary\t-\n`;
    await writeFile(join(sourceRoot, 'study-1.bed'), bed1);
    await writeFile(join(sourceRoot, 'study-2.bed'), bed2);
    await writeFile(join(sourceRoot, 'manifest.tsv'), [
      'study_id\tdataset_row\tgcf\tpmid\tsource_file\tsource_sha256\toutput_file\trecord_count',
      `2020_12345678_${accession}\t1\t${accession}\t12345678\toriginal-1.bed\t${sha256(bed1)}\tstudy-1.bed\t2`,
      `2021_87654321_${accession}\t2\t${accession}\t87654321\toriginal-2.bed\t${sha256(bed2)}\tstudy-2.bed\t1`,
      '',
    ].join('\n'));
    const fasta = await gzip(Buffer.from('>chr\nACGTACGTAC\n'));
    await writeFile(join(ncbiRoot, accession, 'reference.fa.gz'), fasta);
    await writeFile(join(ncbiRoot, accession, 'metadata.json'), JSON.stringify({ organismName: 'Test bacterium', assemblyName: 'ASM test' }));

    const result = await buildExperimentalRelease({
      sourceRoot,
      ncbiRoot,
      output,
      releaseId: 'experimental-test',
      releaseDate: '2026-08-25',
      generatedAt: '2026-08-25T00:00:00.000Z',
      offline: true,
      allowUnindexed: true,
      expected: { studies: 2, genomes: 1, publications: 2, observations: 3 },
    });
    expect(result.catalog).toMatchObject({
      releaseKind: 'experimental_tss',
      assetBase: null,
      summary: { studies: 2, genomes: 1, publications: 2, observations: 3 },
      genomes: [{ annotation: { status: 'missing' }, studies: [
        `2020_12345678_${accession}`, `2021_87654321_${accession}`,
      ] }],
    });
    expect(result.catalog.genomes[0].assets.fasta).toBe(`objects/${accession}/reference.fa`);
    expect(await readFile(join(output, result.catalog.genomes[0].assets.fasta), 'utf8')).toContain('>chr');
    const featureSql = await readFile(join(output, 'd1', '20-feature-sets.sql'), 'utf8');
    expect(featureSql.match(/'experimental_tss'/g)).toHaveLength(2);
    expect(featureSql).toContain("'gene_annotation'");
    expect(featureSql).toContain('rawBedPath');
    expect(featureSql).toContain("'missing'");
    const activateSql = await readFile(join(output, 'd1', '90-activate.sql'), 'utf8');
    expect(activateSql).toContain('experimental_portal_state');
    expect(activateSql).not.toContain('INSERT INTO portal_state');
    await expect(validateExperimentalRelease(output, { expected: false })).resolves.toMatchObject({
      releaseId: 'experimental-test', summary: { observations: 3 },
    });

    const rawPath = resolve(output, result.catalog.studies[0].assets.rawBed);
    await writeFile(rawPath, 'tampered');
    await expect(validateExperimentalRelease(output, { expected: false })).rejects.toThrow('checksum mismatch');
  });

  it('requires an explicit HTTPS asset base only for a production baseline build', async () => {
    const root = await tempRoot();
    const common = {
      sourceRoot: join(root, 'missing-source'),
      ncbiRoot: join(root, 'missing-ncbi'),
      output: join(root, 'release'),
      releaseId: 'production-release',
      releaseDate: '2026-08-25',
      trustSourceChecksums: true,
    };
    await expect(buildExperimentalRelease(common)).rejects.toThrow('requires an HTTPS assetBase');
    await expect(buildExperimentalRelease({ ...common, assetBase: 'http://example.test/release' }))
      .rejects.toThrow('valid HTTPS URL');
    await expect(buildExperimentalRelease({ ...common, assetBase: 'https://user@example.test/release' }))
      .rejects.toThrow('without credentials');
    await expect(buildExperimentalRelease({ ...common, assetBase: 'https://example.test/releases/experimental/' }))
      .rejects.toThrow('manifest.tsv');
  });

  it('renders annotation rows and publication configuration in D1 SQL', () => {
    const catalog = {
      schemaVersion: 1,
      releaseId: 'release-1',
      releaseDate: '2026-08-25',
      generatedAt: '2026-08-25T00:00:00Z',
      description: 'test',
      assetBase: 'https://example.test/release',
      summary: { studies: 1, genomes: 1, publications: 1, observations: 1 },
      studies: [{
        ...study(), organismName: 'Test', recordCount: 1, duplicateGroupCount: 0,
        publication: { title: 'Title', authors: ['Author'], journal: 'Journal', doi: '10.1/x', status: 'resolved' },
        assets: { rawBed: 'objects/a/raw.bed', data: 'objects/a/data.gff3.gz', index: 'objects/a/data.gff3.gz.tbi' },
        checksums: { data: 'b'.repeat(64), index: 'c'.repeat(64) },
      }],
      genomes: [{
        accession: 'GCF_000000001.1', organismName: 'Test', strain: null, assemblyLevel: null, genomeSizeBp: 10,
        contigCount: 1, defaultLocus: 'chr:1-10', primarySequence: 'chr', assemblyName: null,
        genbankAssemblyAccession: 'GCA_000000001.1', referenceStorage: {
          layout: 'individual-v1',
          files: { fasta: 'objects/a/ref.gz' },
          checksums: { fasta: 'f'.repeat(64) },
        },
        annotation: { status: 'available', featureCount: 2, data: 'objects/a/ann.gz', index: 'objects/a/ann.gz.tbi' },
        checksums: { ncbiAnnotations: 'd'.repeat(64), ncbiAnnotationsIndex: 'e'.repeat(64) },
      }],
    };
    const sql = buildExperimentalD1Sql(catalog);
    expect(sql.init).toContain("'experimental_tss'");
    expect(sql.init).toContain('gene-annotation:ncbi:release-1');
    expect(sql.init).toContain('Title');
    expect(sql.init).toContain('INSERT INTO publications');
    expect(sql.init).toContain('INSERT INTO experimental_studies');
    expect(sql.genomes).toContain('INSERT INTO genome_registry');
    expect(sql.genomes).toContain("'ncbi_assembly:GCA_000000001.1'");
    expect(sql.genomes).toContain("'ncbi_refseq', 'GCF_000000001.1'");
    expect(sql.genomes).toContain("'ncbi_genbank', 'GCA_000000001.1'");
    expect(sql.genomes).toContain('INSERT INTO release_genomes');
    expect(sql.genomes).toContain('INSERT INTO experimental_study_genomes');
    expect(sql.features).toContain("'ready'");
    expect(sql.features).toContain("'objects/a/ann.gz'");
    expect(sql.features).toContain('INSERT INTO assets');
    expect(sql.features).toContain("'experimental_tss_rawBed'");
    expect(sql.features).toContain("'gene_annotation_data'");
    expect(sql.activate).not.toMatch(/INSERT INTO portal_state\s*\(/);
  });

  it('adds the independent release kind and portal pointer migration', async () => {
    const migration = await readFile(join(process.cwd(), 'database', 'migrations', '0006_experimental_tss.sql'), 'utf8');
    expect(migration).toContain('ALTER TABLE releases ADD COLUMN release_kind');
    expect(migration).toContain('CREATE TABLE experimental_portal_state');
    expect(migration).toContain("release_kind IN ('prediction', 'experimental_tss')");
    expect(migration).toContain('CREATE TRIGGER portal_state_prediction_release_kind_insert');
    expect(migration).toContain('CREATE TRIGGER portal_state_prediction_release_kind_update');
    expect(migration).toContain('prediction portal requires a prediction release');
  });

  it('adds a unified identity and asset registry without replacing feature sets', async () => {
    const migration = await readFile(join(process.cwd(), 'database', 'migrations', '0007_unified_genome_registry.sql'), 'utf8');
    for (const table of ['genome_registry', 'genome_aliases', 'publications', 'experimental_studies', 'experimental_study_genomes', 'release_genomes', 'assets']) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration).toContain('CHECK (json_valid(provenance_json))');
    expect(migration).toContain('INSERT INTO release_genomes');
    expect(migration).toContain('FROM feature_sets fs');
    expect(migration).not.toContain('CREATE TABLE evidence_sets');
  });
});
