import { describe, expect, it } from 'vitest';

import { D1GenomeCatalogRepository, GenomeCatalogUnavailableError, InvalidGenomeCursorError } from '@/lib/genome-catalog-repository';
import { DEFAULT_GENOME_SEARCH_QUERY } from '@/lib/genome-search-query';

const packedAsset = {
  packPath: 'releases/2026-08-11/packs/pack-00-000.bin',
  offset: 0,
  length: 100,
  sha256: '0'.repeat(64),
  contentType: 'application/gzip',
};

const releaseRow = {
  release_id: '2026-08-11', source_release_id: '2026-08-07', release_date: '2026-08-11', generated_at: '2026-08-11T00:00:00Z',
  description: 'Packed release', layout: 'packed-v1', release_asset_base_url: 'https://huggingface.co/datasets/owner/repo/resolve/main/releases/2026-08-11',
  manifest_index_path: 'manifest-index.json', total_genomes: 2, total_predicted_promoters: 30, total_annotated_genomes: 1,
  total_downloaded_annotations: 1, total_missing_annotations: 1, total_incompatible_annotations: 0, total_usable_annotations: 1,
  total_circular_origin_split_features: 0, total_circular_origin_split_genomes: 0, total_experimental_tss: 0,
  top_phyla_json: '[{"name":"Bacillota","count":2}]',
};

function genomeRow(accession: string, size: number | null, promoters: number) {
  return {
    release_id: '2026-08-11', accession, organism_name: 'Bacillus ' + accession, strain: null, domain: 'Bacteria', phylum: 'Bacillota',
    class_name: 'Bacilli', order_name: 'Bacillales', family: 'Bacillaceae', genus: 'Bacillus', genome_source: 'NCBI GenBank',
    assembly_level: null, genome_size_bp: size, gc_content: 42, contig_count: 1, completeness: null, contamination: null,
    predicted_promoter_count: promoters, annotation_status: accession.endsWith('1.1') ? 'available' : 'missing', annotation_feature_count: 1,
    annotation_circular_origin_split_count: 0, experimental_tss_count: 0, has_experimental_tss: 0, default_locus: 'chr:1-10', primary_sequence: 'chr',
    logical_object_prefix: '00/' + accession,
    assets_json: JSON.stringify({ fasta: accession + '/reference.fa.gz', fastaFai: accession + '/reference.fa.gz.fai', fastaGzi: accession + '/reference.fa.gz.gzi', predictedPromoters: accession + '/predicted-promoters.gff3.gz', predictedPromotersIndex: accession + '/predicted-promoters.gff3.gz.tbi', ncbiAnnotations: null, ncbiAnnotationsIndex: null, metadata: accession + '/metadata.json' }),
    storage_json: JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/' + accession, assets: { 'reference.fa.gz': packedAsset } }),
  };
}

type Recorded = { query: string; bindings: Array<string | number | null> };

class FakeStatement implements D1PreparedStatement {
  bindings: Array<string | number | null> = [];
  constructor(private database: FakeD1, readonly query: string) {}
  bind(...values: Array<string | number | null>) { this.bindings = values; this.database.recorded.push({ query: this.query, bindings: values }); return this; }
  async first<T>() {
    if (this.query.includes('FROM portal_state')) return this.database.release as T;
    if (this.query.startsWith('SELECT COUNT')) return { count: this.database.rows.length } as T;
    if (this.query.includes('FROM genomes WHERE')) return (this.database.rows.find((row) => row.accession === this.bindings[1]) || null) as T | null;
    if (this.query.startsWith('SELECT g.') && this.query.includes(' AS cursor_value FROM genomes g')) {
      const row = this.database.rows.find((candidate) => candidate.accession === this.bindings[this.bindings.length - 1]);
      if (!row) return null;
      const value = this.query.includes('genome_size_bp') ? row.genome_size_bp
        : this.query.includes('predicted_promoter_count') ? row.predicted_promoter_count
          : this.query.includes('organism_name') ? row.organism_name : row.accession;
      return { cursor_value: value } as T;
    }
    return null;
  }
  async all<T>() {
    if (this.query.startsWith('SELECT g.*')) return { results: this.database.rows, success: true, meta: {} } as D1Result<T>;
    return { results: [], success: true, meta: {} };
  }
}

class FakeD1 implements D1Database {
  recorded: Recorded[] = [];
  release = { ...releaseRow };
  rows = [genomeRow('GCA_000000001.1', 2_000_000, 20), genomeRow('GCA_000000002.1', null, 10)];
  prepare(query: string) { return new FakeStatement(this, query); }
  async batch<T>(statements: D1PreparedStatement[]) {
    return statements.map((_statement, index) => ({ results: index === 0 ? [{ value: 'NCBI GenBank' }] : [{ value: ['Bacteria', 'Bacillota', 'Bacilli', 'Bacillales', 'Bacillaceae', 'Bacillus'][index - 1] }], success: true, meta: {} })) as Array<D1Result<T>>;
  }
}

describe('D1 genome catalog repository', () => {
  it('reads the active release summary and exact accession storage mapping', async () => {
    const database = new FakeD1();
    const repository = new D1GenomeCatalogRepository(database);
    const summary = await repository.getActiveRelease();
    expect(summary).toMatchObject({ releaseId: '2026-08-11', sourceReleaseId: '2026-08-07', manifestIndexPath: 'manifest-index.json', totalGenomes: 2 });

    const match = await repository.getByAccession('GCA_000000001.1');
    expect(match?.releaseId).toBe('2026-08-11');
    expect(match?.storage).toMatchObject({ layout: 'packed-v1', baseUrl: 'https://huggingface.co/datasets/owner/repo/resolve/main' });
    expect(await repository.getByAccession('GCA_000000001')).toBeNull();
  });

  it('generates multi-token prefix search, filters, null-last sort, and cascading facet bindings', async () => {
    const database = new FakeD1();
    const repository = new D1GenomeCatalogRepository(database);
    const result = await repository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      q: 'bacillus subtilis', source: 'NCBI GenBank', annotation: 'unavailable', sort: 'genome-size', direction: 'desc',
      taxonomy: { domain: 'Bacteria', phylum: 'Bacillota', class: '', order: '', family: '', genus: '' },
    });
    expect(result.releaseId).toBe('2026-08-11');
    expect(result.facets.taxonomy.genus).toEqual(['Bacillus']);
    const pageQuery = database.recorded.find((entry) => entry.query.startsWith('SELECT g.*'))!;
    expect(pageQuery.query).toContain('st.token >= ? AND st.token < ?');
    expect(pageQuery.query).not.toContain(' LIKE ');
    expect(pageQuery.query).toContain("g.annotation_status <> 'available'");
    expect(pageQuery.query).toContain('g.genome_size_bp IS NULL ASC');
    expect(pageQuery.bindings).toEqual(expect.arrayContaining(['bacillus', 'bacillus\uffff', 'subtilis', 'subtilis\uffff', 'Bacteria', 'Bacillota', 'NCBI GenBank']));
    const facetGenus = database.recorded.find((entry) => entry.query.includes("kind = ?") && entry.bindings[1] === 'genus')!;
    expect(facetGenus.bindings).toEqual(['2026-08-11', 'genus', 'Bacteria', 'Bacillota']);
  });

  it('binds v2 cursors to the active release and complete query configuration', async () => {
    const database = new FakeD1();
    database.rows = Array.from({ length: 26 }, (_, index) => genomeRow('GCA_' + String(index + 1).padStart(9, '0') + '.1', index, index));
    const repository = new D1GenomeCatalogRepository(database);
    const first = await repository.search(DEFAULT_GENOME_SEARCH_QUERY);
    expect(first.pageInfo.hasNext).toBe(true);
    expect(first.pageInfo.nextCursor).toBeTruthy();
    await expect(repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, direction: 'desc', cursor: first.pageInfo.nextCursor })).rejects.toBeInstanceOf(InvalidGenomeCursorError);
    await expect(repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, q: 'bacillus', cursor: first.pageInfo.nextCursor })).rejects.toBeInstanceOf(InvalidGenomeCursorError);
    const payload = JSON.parse(Buffer.from(first.pageInfo.nextCursor!, 'base64url').toString('utf8'));
    payload.releaseId = '2026-08-07';
    await expect(repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, cursor: Buffer.from(JSON.stringify(payload)).toString('base64url') })).rejects.toBeInstanceOf(InvalidGenomeCursorError);

    const forged = JSON.parse(Buffer.from(first.pageInfo.nextCursor!, 'base64url').toString('utf8'));
    forged.accession = 'GCA_999999999.1';
    await expect(repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') })).rejects.toBeInstanceOf(InvalidGenomeCursorError);

    const forgedValue = JSON.parse(Buffer.from(first.pageInfo.nextCursor!, 'base64url').toString('utf8'));
    forgedValue.value = 'GCA_000000024.1';
    await expect(repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, cursor: Buffer.from(JSON.stringify(forgedValue)).toString('base64url') })).rejects.toBeInstanceOf(InvalidGenomeCursorError);
  });

  it.each([
    ['malformed JSON', '{'],
    ['array mapping', JSON.stringify([])],
    ['array assets', JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: [] })],
    ['empty assets', JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: {} })],
    ['traversal pack path', JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: { file: { ...packedAsset, packPath: '../pack.bin' } } })],
    ['wrong release pack path', JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: { file: { ...packedAsset, packPath: 'releases/2026-08-07/packs/pack-00-000.bin' } } })],
    ['negative offset', JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: { file: { ...packedAsset, offset: -1 } } })],
    ['fractional offset', JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: { file: { ...packedAsset, offset: 1.5 } } })],
    ['negative length', JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: { file: { ...packedAsset, length: -1 } } })],
    ['fractional length', JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: { file: { ...packedAsset, length: 1.5 } } })],
    ['invalid sha256', JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: { file: { ...packedAsset, sha256: 'not-a-sha256' } } })],
    ['empty content type', JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: { file: { ...packedAsset, contentType: '   ' } } })],
  ])('rejects packed storage with %s', async (_label, storageJson) => {
    const database = new FakeD1();
    database.rows[0].storage_json = storageJson;
    const repository = new D1GenomeCatalogRepository(database);
    await expect(repository.getByAccession('GCA_000000001.1')).rejects.toBeInstanceOf(GenomeCatalogUnavailableError);
  });

  it('accepts legacy individual storage and rejects invalid base URLs or release layout mismatches', async () => {
    const database = new FakeD1();
    database.release = {
      ...database.release,
      release_id: '2026-08-07',
      layout: 'individual-v1',
      release_asset_base_url: 'https://huggingface.co/datasets/owner/pilot/resolve/main/releases/2026-08-07',
    };
    database.rows[0].release_id = '2026-08-07';
    database.rows[0].storage_json = JSON.stringify({
      layout: 'individual-v1',
      logicalObjectPrefix: 'GCA_000000001.1',
      baseUrl: 'https://huggingface.co/datasets/owner/pilot/resolve/main/releases/2026-08-07',
    });
    const repository = new D1GenomeCatalogRepository(database);
    await expect(repository.getByAccession('GCA_000000001.1')).resolves.toMatchObject({
      storage: { layout: 'individual-v1', baseUrl: 'https://huggingface.co/datasets/owner/pilot/resolve/main/releases/2026-08-07' },
    });

    database.rows[0].storage_json = JSON.stringify({ layout: 'individual-v1', logicalObjectPrefix: 'GCA_000000001.1' });
    await expect(repository.getByAccession('GCA_000000001.1')).resolves.toMatchObject({
      storage: { layout: 'individual-v1', baseUrl: 'https://huggingface.co/datasets/owner/pilot/resolve/main/releases/2026-08-07' },
    });

    database.rows[0].storage_json = JSON.stringify({ layout: 'individual-v1', logicalObjectPrefix: 'GCA_000000001.1', baseUrl: 42 });
    await expect(repository.getByAccession('GCA_000000001.1')).rejects.toBeInstanceOf(GenomeCatalogUnavailableError);

    database.rows[0].storage_json = JSON.stringify({ layout: 'individual-v1', logicalObjectPrefix: 'GCA_000000001.1', baseUrl: ' ' });
    await expect(repository.getByAccession('GCA_000000001.1')).rejects.toBeInstanceOf(GenomeCatalogUnavailableError);

    database.rows[0].storage_json = JSON.stringify({ layout: 'packed-v1', logicalObjectPrefix: '00/GCA_000000001.1', assets: { file: packedAsset } });
    await expect(repository.getByAccession('GCA_000000001.1')).rejects.toBeInstanceOf(GenomeCatalogUnavailableError);
  });

  it('rejects a genome row from a release other than the active release', async () => {
    const database = new FakeD1();
    database.rows[0].release_id = '2026-08-07';
    const repository = new D1GenomeCatalogRepository(database);
    await expect(repository.getByAccession('GCA_000000001.1')).rejects.toBeInstanceOf(GenomeCatalogUnavailableError);
  });
});
