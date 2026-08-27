import { describe, expect, it } from 'vitest';
import { D1ExperimentalTssRepository, JsonExperimentalTssRepository } from '@/features/genome-browser/experimental-tss-repository';

const sha = 'a'.repeat(64);

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    releaseId: '2026-08-25-experimental-tss',
    releaseKind: 'experimental_tss',
    generatedAt: '2026-08-25T00:00:00Z',
    assetBase: 'https://example.test/releases/experimental',
    summary: { studies: 2, genomes: 1, publications: 2, observations: 5 },
    studies: [
      {
        studyId: '2012_22251276_GCF_000210855.2', gcf: 'GCF_000210855.2', pmid: '22251276', year: 2012,
        recordCount: 2, sourceFile: 'source-one.bed', sourceSha256: sha,
        publication: { title: 'Primary transcriptome study', authors: ['A. Author'], journal: 'RNA', doi: '10.1/example', status: 'resolved' },
        assets: { rawBed: 'studies/one/raw.bed', data: 'studies/one/experimental-tss.gff3.gz', index: 'studies/one/experimental-tss.gff3.gz.tbi' },
        checksums: { rawBed: sha, data: sha, index: sha },
      },
      {
        studyId: '2012_22538806_GCF_000210855.2', gcf: 'GCF_000210855.2', pmid: '22538806', year: 2012,
        recordCount: 3, publication: { title: 'Independent TSS map', authors: [], journal: 'Nature', doi: null, status: 'resolved' },
        assets: { rawBed: 'studies/two/raw.bed', data: 'studies/two/experimental-tss.gff3.gz', index: 'studies/two/experimental-tss.gff3.gz.tbi' },
      },
    ],
    genomes: [{
      accession: 'GCF_000210855.2', organismName: 'Escherichia coli test', defaultLocus: 'NC_016810.1:1-1000', primarySequence: 'NC_016810.1',
      genomeSizeBp: 5_000_000, contigCount: 1,
      studies: ['2012_22251276_GCF_000210855.2', '2012_22538806_GCF_000210855.2'],
      referenceStorage: { layout: 'individual-v1', files: { fasta: 'genomes/GCF_000210855.2/reference.fa.gz', fai: 'genomes/GCF_000210855.2/reference.fa.gz.fai', gzi: 'genomes/GCF_000210855.2/reference.fa.gz.gzi' }, checksums: { fasta: sha } },
      annotation: { status: 'available', data: 'genomes/GCF_000210855.2/ncbi-annotations.gff3.gz', index: 'genomes/GCF_000210855.2/ncbi-annotations.gff3.gz.tbi' },
    }],
    ...overrides,
  };
}

describe('experimental TSS repository', () => {
  it('keeps studies separate and searches organism, GCF, PMID, title and year', async () => {
    const repository = new JsonExperimentalTssRepository(catalog());
    const all = await repository.search();
    expect(all.release).toMatchObject({ studies: 2, genomes: 1, publications: 2, observations: 5, years: [2012] });
    expect(all.items.map((study) => study.studyId)).toHaveLength(2);
    expect((await repository.search({ q: '22538806' })).items).toHaveLength(1);
    expect((await repository.search({ q: 'independent tss' })).items[0]?.pmid).toBe('22538806');
    expect((await repository.search({ q: 'escherichia' })).items).toHaveLength(2);
    expect((await repository.search({ year: 2013 })).items).toHaveLength(0);
  });

  it('builds a genome with all study tracks and keeps prediction fields out', async () => {
    const genome = await new JsonExperimentalTssRepository(catalog()).getGenome('GCF_000210855.2');
    expect(genome).toMatchObject({
      accession: 'GCF_000210855.2', defaultLocus: 'NC_016810.1:1-1000', annotationStatus: 'available',
      assetBase: '/api/experimental-data/GCF_000210855.2',
      assets: { fasta: 'reference.fa.gz', ncbiAnnotations: 'ncbi-annotations.gff3.gz' },
    });
    expect(genome?.studies).toHaveLength(2);
    expect(genome?.studies[0]?.assets.data).toContain('studies/2012_22251276_GCF_000210855.2/');
    expect(genome).not.toHaveProperty('predictedPromoterCount');
  });

  it('keeps unindexed subset references usable without inventing FAI or GZI assets', async () => {
    const value = catalog();
    const genome = value.genomes[0] as { referenceStorage: { files: Record<string, string> } };
    delete genome.referenceStorage.files.fai;
    delete genome.referenceStorage.files.gzi;
    await expect(new JsonExperimentalTssRepository(value).getGenome('GCF_000210855.2')).resolves.toMatchObject({
      assets: { fasta: 'reference.fa', fastaFai: null, fastaGzi: null },
    });
  });

  it('resolves only exact catalog assets for the selected genome and study', async () => {
    const repository = new JsonExperimentalTssRepository(catalog());
    const reference = await repository.resolveAsset('GCF_000210855.2', 'reference.fa.gz');
    const gff = await repository.resolveAsset('GCF_000210855.2', 'studies/2012_22251276_GCF_000210855.2/experimental-tss.gff3.gz');
    expect(reference?.upstreamUrl).toBe('https://example.test/releases/experimental/genomes/GCF_000210855.2/reference.fa.gz');
    expect(gff).toMatchObject({ kind: 'experimental-tss', filename: '2012_22251276_GCF_000210855.2.experimental-tss.gff3.gz' });
    expect(await repository.resolveAsset('GCF_000210855.2', 'studies/2012_22251276_GCF_000210855.2/../../secret')).toBeNull();
    expect(await repository.resolveAsset('GCF_000210855.2', 'studies/2012_22538806_GCF_000210855.9/raw.bed')).toBeNull();
    expect(await repository.resolveAsset('GCF_000000001.1', 'reference.fa.gz')).toBeNull();
  });

  it('reuses an existing BED as the unindexed browser source', async () => {
    const value = catalog();
    const study = value.studies[0];
    const assets = study.assets as { data: string; index: string | null };
    assets.data = 'experimentally_supported_tss_by_study/2012_22251276_GCF_000210855.2.bed';
    assets.index = null;
    const repository = new JsonExperimentalTssRepository(value);
    const genome = await repository.getGenome('GCF_000210855.2');
    expect(genome?.studies[0]?.assets.data).toBe('studies/2012_22251276_GCF_000210855.2/experimental-tss.gff3');
    await expect(repository.resolveAsset(
      'GCF_000210855.2',
      'studies/2012_22251276_GCF_000210855.2/experimental-tss.gff3',
    )).resolves.toMatchObject({
      upstreamUrl: 'https://example.test/releases/experimental/experimentally_supported_tss_by_study/2012_22251276_GCF_000210855.2.bed',
      contentType: 'text/plain; charset=utf-8',
      transform: { kind: 'experimental-bed-to-gff3', studyId: '2012_22251276_GCF_000210855.2' },
    });
  });

  it('rejects unsafe paths before they can become upstream URLs', () => {
    const unsafe = catalog();
    (unsafe.studies[0].assets as { rawBed: string }).rawBed = '../secret.bed';
    expect(() => new JsonExperimentalTssRepository(unsafe)).toThrow(/safe release path/);
  });

  it('reads only the experimental D1 pointer, preserves two studies, and resolves missing annotation assets safely', async () => {
    const queries: string[] = [];
    class Statement {
      bindings: Array<string | number | null> = [];
      constructor(readonly query: string) { queries.push(query); }
      bind(...values: Array<string | number | null>) { this.bindings = values; return this; }
      async first<T>() {
        if (!this.query.includes('FROM experimental_portal_state')) return null;
        return {
          release_id: 'experimental-1', release_kind: 'experimental_tss', publication_status: 'ready',
          generated_at: '2026-08-25T00:00:00Z', description: 'Experimental release',
          release_asset_base_url: 'https://example.test/releases/experimental-1', total_genomes: 1,
          feature_summary_json: JSON.stringify({ experimentalStudies: 2, experimentalTss: 5, publications: 2 }),
        } as T;
      }
    }
    const studyRows = [
      {
        release_id: 'experimental-1', accession: 'GCF_000210855.2', definition_id: '2012_22251276_GCF_000210855.2',
        source_id: '2012_22251276_GCF_000210855.2', source_version: 'pmid:22251276', feature_count: 2,
        configuration_json: JSON.stringify({ pmid: '22251276', year: 2012, publication: { title: 'First map', authors: [], journal: 'RNA', doi: null, status: 'resolved' } }),
        provenance_json: JSON.stringify({ rawBedPath: 'objects/GCF_000210855.2/studies/first/raw.bed', sourceFile: 'first.bed', sourceSha256: sha, datasetRow: 1 }),
        data_path: 'objects/GCF_000210855.2/studies/first/experimental-tss.gff3.gz', index_path: 'objects/GCF_000210855.2/studies/first/experimental-tss.gff3.gz.tbi',
        data_sha256: sha, index_sha256: sha, organism_name: 'Escherichia coli',
      },
      {
        release_id: 'experimental-1', accession: 'GCF_000210855.2', definition_id: '2012_22538806_GCF_000210855.2',
        source_id: '2012_22538806_GCF_000210855.2', source_version: 'pmid:22538806', feature_count: 3,
        configuration_json: JSON.stringify({ pmid: '22538806', year: 2012, publication: { title: 'Second map', authors: [], journal: 'Nature', doi: null, status: 'resolved' } }),
        provenance_json: JSON.stringify({ rawBedPath: 'objects/GCF_000210855.2/studies/second/raw.bed', sourceFile: 'second.bed', sourceSha256: sha, datasetRow: 2 }),
        data_path: 'objects/GCF_000210855.2/studies/second/experimental-tss.gff3.gz', index_path: 'objects/GCF_000210855.2/studies/second/experimental-tss.gff3.gz.tbi',
        data_sha256: sha, index_sha256: sha, organism_name: 'Escherichia coli',
      },
    ];
    const genomeRows = [{
      release_id: 'experimental-1', accession: 'GCF_000210855.2', organism_name: 'Escherichia coli', strain: null,
      assembly_name: 'ASM test', genbank_assembly_accession: 'GCA_000210855.2', default_locus: 'NC_016810.1:1-1000',
      primary_sequence: 'NC_016810.1', genome_size_bp: 5_000_000, contig_count: 1,
      reference_accession: 'GCA_000210855.2',
      reference_storage_json: JSON.stringify({ layout: 'individual-v1', files: {
        fasta: 'objects/GCF_000210855.2/reference.fa.gz', fai: 'objects/GCF_000210855.2/reference.fa.gz.fai', gzi: 'objects/GCF_000210855.2/reference.fa.gz.gzi',
      } }),
      annotation_status: null, annotation_data_path: null, annotation_index_path: null,
      annotation_data_sha256: null, annotation_index_sha256: null,
    }];
    const database = {
      prepare(query: string) { return new Statement(query); },
      async batch(statements: Statement[]) {
        return statements.map((statement) => ({
          success: true, meta: {},
          results: statement.query.includes("fs.feature_type = 'experimental_tss'") ? studyRows : genomeRows,
        }));
      },
    } as unknown as D1Database;
    const repository = new D1ExperimentalTssRepository(database);

    const result = await repository.search();
    expect(result.release).toMatchObject({ releaseId: 'experimental-1', studies: 2, genomes: 1, publications: 2, observations: 5 });
    expect(result.items.map((study) => study.pmid)).toEqual(['22251276', '22538806']);
    const genome = await repository.getGenome('GCF_000210855.2');
    expect(genome).toMatchObject({
      referenceAccession: 'GCA_000210855.2',
      annotationStatus: 'missing',
      assets: { ncbiAnnotations: null, ncbiAnnotationsIndex: null },
    });
    expect(genome?.studies).toHaveLength(2);
    await expect(repository.resolveAsset('GCF_000210855.2', 'ncbi-annotations.gff3.gz')).resolves.toBeNull();
    await expect(repository.resolveAsset('GCF_000210855.2', 'studies/2012_22538806_GCF_000210855.2/raw.bed')).resolves.toMatchObject({
      upstreamUrl: 'https://example.test/releases/experimental-1/objects/GCF_000210855.2/studies/second/raw.bed',
      kind: 'raw-bed',
    });
    expect(queries.filter((query) => query.includes('FROM experimental_portal_state')).length).toBeGreaterThan(0);
    expect(queries.some((query) => query.includes('FROM portal_state p'))).toBe(false);
  });
});
