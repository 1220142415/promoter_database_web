import { describe, expect, it } from 'vitest';

import { D1GenomeCatalogRepository, GenomeCatalogUnavailableError, InvalidGenomeCursorError } from '@/lib/genome-catalog-repository';
import { DEFAULT_GENOME_SEARCH_QUERY } from '@/lib/genome-search-query';

const releaseRow = {
  release_id: '2026-08-07',
  source_release_id: null,
  release_date: '2026-08-07',
  generated_at: '2026-08-07T00:00:00Z',
  description: 'Feature catalog release',
  storage_layout: 'individual-v1',
  release_asset_base_url: 'https://huggingface.co/datasets/owner/pilot/resolve/main/releases/2026-08-07',
  manifest_index_path: null,
  total_genomes: 2,
  feature_summary_json: '{"promoter":{"genomeCount":2,"featureCount":30}}',
};

function genomeRow(accession: string, size: number | null, promoters: number) {
  return {
    release_id: '2026-08-07',
    accession,
    organism_name: 'Bacillus ' + accession,
    strain: null,
    domain: 'Bacteria',
    phylum: 'Bacillota',
    class_name: 'Bacilli',
    order_name: 'Bacillales',
    family: 'Bacillaceae',
    genus: 'Bacillus',
    genome_source: 'NCBI GenBank',
    assembly_level: null,
    genome_size_bp: size,
    gc_content: 42,
    contig_count: 1,
    completeness: null,
    contamination: null,
    default_locus: 'chr:1-10',
    primary_sequence: 'chr',
    reference_storage_json: JSON.stringify({
      layout: 'individual-v1',
      files: {
        fasta: `objects/${accession}/reference.fa.gz`,
        fai: `objects/${accession}/reference.fa.gz.fai`,
        gzi: `objects/${accession}/reference.fa.gz.gzi`,
        metadata: `objects/${accession}/metadata.json`,
      },
    }),
    predicted_promoter_count: promoters,
    promoter_status: 'ready',
    promoter_data_path: `objects/${accession}/predicted-promoters.gff3.gz`,
    promoter_index_path: `objects/${accession}/predicted-promoters.gff3.gz.tbi`,
    promoter_storage_json: '{}',
    annotation_status: accession.endsWith('1.1') ? 'ready' : null,
    annotation_feature_count: accession.endsWith('1.1') ? 120 : null,
    annotation_data_path: accession.endsWith('1.1') ? `objects/${accession}/ncbi-annotations.gff3.gz` : null,
    annotation_index_path: accession.endsWith('1.1') ? `objects/${accession}/ncbi-annotations.gff3.gz.tbi` : null,
  };
}

type JoinedGenomeRow = ReturnType<typeof genomeRow>;
type Recorded = { query: string; bindings: Array<string | number | null> };

const D1_META: D1Meta & Record<string, unknown> = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
};

function d1Result<T>(results: T[]): D1Result<T> {
  return { results, success: true, meta: D1_META };
}

class FakeStatement implements D1PreparedStatement {
  bindings: Array<string | number | null> = [];

  constructor(private database: FakeD1, readonly query: string) {}

  bind(...values: unknown[]) {
    const bindings = values as Array<string | number | null>;
    this.bindings = bindings;
    this.database.recorded.push({ query: this.query, bindings });
    return this;
  }

  async first<T>() {
    if (this.query.includes('FROM portal_state')) return this.database.release as T;
    if (this.query.startsWith('SELECT COUNT')) return { count: this.database.rows.length } as T;
    if (this.query.startsWith('SELECT g.*')) {
      return (this.database.rows.find((row) => row.accession === this.bindings[1]) || null) as T | null;
    }
    if (this.query.includes(' AS cursor_value FROM genomes g')) {
      const row = this.database.rows.find((candidate) => candidate.accession === this.bindings[this.bindings.length - 1]);
      if (!row) return null;
      const value = this.query.includes('genome_size_bp') ? row.genome_size_bp
        : this.query.includes('p.feature_count') ? row.predicted_promoter_count
          : this.query.includes('organism_name') ? row.organism_name : row.accession;
      return { cursor_value: value } as T;
    }
    return null;
  }

  async run<T = Record<string, unknown>>() {
    return d1Result<T>([]);
  }

  async all<T = Record<string, unknown>>() {
    if (this.query.startsWith('SELECT feature_type')) {
      return d1Result(this.database.aggregates as T[]);
    }
    if (this.query.startsWith('SELECT g.*')) {
      return d1Result(this.database.rows as T[]);
    }
    return d1Result<T>([]);
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }) {
    return options?.columnNames ? [[],] as [string[], ...T[]] : [] as T[];
  }
}

class FakeD1 implements D1Database {
  recorded: Recorded[] = [];
  release = { ...releaseRow };
  rows: JoinedGenomeRow[] = [
    genomeRow('GCA_000000001.1', 2_000_000, 20),
    genomeRow('GCA_000000002.1', null, 10),
  ];
  aggregates = [
    { feature_type: 'promoter', status: 'ready', genome_count: 2, feature_count: 30 },
    { feature_type: 'gene_annotation', status: 'ready', genome_count: 1, feature_count: 120 },
    { feature_type: 'gene_annotation', status: 'missing', genome_count: 1, feature_count: null },
  ];

  prepare(query: string) { return new FakeStatement(this, query); }

  async exec(query: string) { void query; return { count: 0, duration: 0 }; }
  withSession(): D1DatabaseSession { throw new Error('not implemented by fake'); }
  async dump() { return new ArrayBuffer(0); }

  async batch<T>(statements: D1PreparedStatement[]) {
    return statements.map((_statement, index) => d1Result([{
      value: index === 0
        ? 'NCBI GenBank'
        : ['Bacteria', 'Bacillota', 'Bacilli', 'Bacillales', 'Bacillaceae', 'Bacillus'][index - 1],
    } as T]));
  }
}

describe('D1 genome catalog repository', () => {
  it('maps the feature catalog schema to the portal model', async () => {
    const repository = new D1GenomeCatalogRepository(new FakeD1());
    const summary = await repository.getActiveRelease();
    expect(summary).toMatchObject({
      releaseId: '2026-08-07',
      totalGenomes: 2,
      totalPredictedPromoters: 30,
      totalAnnotatedGenomes: 1,
      totalMissingAnnotations: 1,
    });

    const match = await repository.getByAccession('GCA_000000001.1');
    expect(match?.storage).toMatchObject({
      layout: 'individual-v1',
      logicalObjectPrefix: 'GCA_000000001.1',
      baseUrl: 'https://huggingface.co/datasets/owner/pilot/resolve/main/releases/2026-08-07/objects',
    });
    expect(match?.genome).toMatchObject({
      predictedPromoterCount: 20,
      annotationStatus: 'available',
      annotationFeatureCount: 120,
      assets: {
        fasta: 'GCA_000000001.1/reference.fa.gz',
        predictedPromoters: 'GCA_000000001.1/predicted-promoters.gff3.gz',
      },
    });
    expect(await repository.getByAccession('GCA_000000001')).toBeNull();
  });

  it('joins default feature sets for search, sorting, and annotation filters', async () => {
    const database = new FakeD1();
    const repository = new D1GenomeCatalogRepository(database);
    const result = await repository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      q: 'bacillus subtilis',
      source: 'NCBI GenBank',
      annotation: 'unavailable',
      sort: 'promoters',
      direction: 'desc',
      taxonomy: { domain: 'Bacteria', phylum: 'Bacillota', class: '', order: '', family: '', genus: '' },
    });
    expect(result.releaseId).toBe('2026-08-07');
    expect(result.facets.taxonomy.genus).toEqual(['Bacillus']);
    const pageQuery = database.recorded.find((entry) => entry.query.startsWith('SELECT g.*'))!;
    expect(pageQuery.query).toContain("p.feature_type = 'promoter'");
    expect(pageQuery.query).toContain("a.feature_type = 'gene_annotation'");
    expect(pageQuery.query).toContain("COALESCE(a.status, 'missing') <> 'ready'");
    expect(pageQuery.query).toContain('COALESCE(p.feature_count, 0) DESC');
    expect(pageQuery.query).toContain('st.token >= ? AND st.token < ?');
    expect(pageQuery.query).not.toContain(' LIKE ');
    expect(pageQuery.bindings).toEqual(expect.arrayContaining([
      'bacillus', 'bacillus\uffff', 'subtilis', 'subtilis\uffff', 'Bacteria', 'Bacillota', 'NCBI GenBank',
    ]));
  });

  it('binds cursors to the active release and complete query configuration', async () => {
    const database = new FakeD1();
    database.rows = Array.from({ length: 26 }, (_, index) => genomeRow(
      'GCA_' + String(index + 1).padStart(9, '0') + '.1',
      index,
      index,
    ));
    const repository = new D1GenomeCatalogRepository(database);
    const first = await repository.search(DEFAULT_GENOME_SEARCH_QUERY);
    expect(first.pageInfo.hasNext).toBe(true);
    expect(first.pageInfo.nextCursor).toBeTruthy();
    await expect(repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, direction: 'desc', cursor: first.pageInfo.nextCursor }))
      .rejects.toBeInstanceOf(InvalidGenomeCursorError);
    await expect(repository.search({ ...DEFAULT_GENOME_SEARCH_QUERY, q: 'bacillus', cursor: first.pageInfo.nextCursor }))
      .rejects.toBeInstanceOf(InvalidGenomeCursorError);

    const forged = JSON.parse(Buffer.from(first.pageInfo.nextCursor!, 'base64url').toString('utf8'));
    forged.accession = 'GCA_999999999.1';
    await expect(repository.search({
      ...DEFAULT_GENOME_SEARCH_QUERY,
      cursor: Buffer.from(JSON.stringify(forged)).toString('base64url'),
    })).rejects.toBeInstanceOf(InvalidGenomeCursorError);
  });

  it.each([
    ['malformed reference JSON', '{'],
    ['array reference mapping', JSON.stringify([])],
    ['wrong storage layout', JSON.stringify({ layout: 'packed-v1', files: {} })],
    ['missing reference files', JSON.stringify({ layout: 'individual-v1' })],
    ['traversal reference path', JSON.stringify({ layout: 'individual-v1', files: { fasta: '../reference.fa.gz' } })],
    ['cross-genome reference path', JSON.stringify({ layout: 'individual-v1', files: { fasta: 'objects/GCA_999999999.1/reference.fa.gz' } })],
  ])('rejects %s', async (_label, referenceStorageJson) => {
    const database = new FakeD1();
    database.rows[0].reference_storage_json = referenceStorageJson;
    const repository = new D1GenomeCatalogRepository(database);
    await expect(repository.getByAccession('GCA_000000001.1')).rejects.toBeInstanceOf(GenomeCatalogUnavailableError);
  });

  it('rejects a genome row from a release other than the active release', async () => {
    const database = new FakeD1();
    database.rows[0].release_id = '2026-08-11';
    const repository = new D1GenomeCatalogRepository(database);
    await expect(repository.getByAccession('GCA_000000001.1')).rejects.toBeInstanceOf(GenomeCatalogUnavailableError);
  });
});
