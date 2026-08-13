import 'server-only';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { getReleaseCatalog, getReleaseGenome } from '@/lib/catalog-server';
import type {
  GenomeCatalogMatch,
  GenomeCatalogRow,
  GenomeSearchQuery,
  GenomeSearchResponse,
  GenomeSortDirection,
  GenomeSortField,
  GenomeTaxonomyFacets,
  GenomeTaxonomyRank,
} from '@/types/genome-catalog';
import type { ReleaseGenome } from '@/types/release';
import type { ActiveReleaseSummary, GenomeStorageMap, PackedAsset } from '@/types/release';

type SortValue = string | number | null;

interface CursorPayload {
  v: 2;
  releaseId: string;
  query: string;
  sort: GenomeSortField;
  direction: GenomeSortDirection;
  value: SortValue;
  accession: string;
}

const TAXONOMY_RANKS: Array<{ key: GenomeTaxonomyRank; field: keyof ReleaseGenome }> = [
  { key: 'domain', field: 'domain' },
  { key: 'phylum', field: 'phylum' },
  { key: 'class', field: 'className' },
  { key: 'order', field: 'orderName' },
  { key: 'family', field: 'family' },
  { key: 'genus', field: 'genus' },
];

function assetBaseForAccession(accession: string, defaultBase: string) {
  if (process.env.HF_STORAGE_BASE_URL) return '/api/remote-data';
  if (!process.env.HF_PILOT_STORAGE_BASE_URL) return defaultBase;
  const pilotAccessions = new Set((process.env.HF_PILOT_ACCESSIONS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
  return pilotAccessions.has(accession)
    ? process.env.HF_PILOT_STORAGE_BASE_URL.replace(/\/+$/, '')
    : defaultBase;
}

export class GenomeCatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenomeCatalogUnavailableError';
  }
}

export class InvalidGenomeCursorError extends Error {
  constructor(message = 'cursor is invalid') {
    super(message);
    this.name = 'InvalidGenomeCursorError';
  }
}

export interface GenomeCatalogRepository {
  search(query: GenomeSearchQuery): Promise<GenomeSearchResponse>;
  getByAccession(accession: string): Promise<GenomeCatalogMatch | null>;
  getActiveRelease(): Promise<ActiveReleaseSummary>;
}

function toCatalogRow(genome: ReleaseGenome): GenomeCatalogRow {
  return {
    accession: genome.accession,
    organismName: genome.organismName,
    strain: genome.strain,
    domain: genome.domain,
    phylum: genome.phylum,
    className: genome.className,
    orderName: genome.orderName,
    family: genome.family,
    genus: genome.genus,
    genomeSource: genome.genomeSource,
    genomeSizeBp: genome.genomeSizeBp,
    contigCount: genome.contigCount,
    predictedPromoterCount: genome.predictedPromoterCount,
    annotationStatus: genome.annotationStatus,
  };
}

function sortValue(genome: ReleaseGenome, field: GenomeSortField): SortValue {
  if (field === 'organism') return genome.organismName;
  if (field === 'genome-size') return genome.genomeSizeBp;
  if (field === 'promoters') return genome.predictedPromoterCount;
  return genome.accession;
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right);
}

function compareGenomes(left: ReleaseGenome, right: ReleaseGenome, field: GenomeSortField, direction: GenomeSortDirection) {
  if (field === 'genome-size' && (left.genomeSizeBp === null || right.genomeSizeBp === null)) {
    if (left.genomeSizeBp === null && right.genomeSizeBp !== null) return 1;
    if (left.genomeSizeBp !== null && right.genomeSizeBp === null) return -1;
  }

  let primary = 0;
  if (field === 'organism') primary = compareStrings(left.organismName, right.organismName);
  else if (field === 'genome-size') primary = (left.genomeSizeBp || 0) - (right.genomeSizeBp || 0);
  else if (field === 'promoters') primary = left.predictedPromoterCount - right.predictedPromoterCount;
  else primary = compareStrings(left.accession, right.accession);

  const directed = primary * (direction === 'asc' ? 1 : -1);
  return directed || compareStrings(left.accession, right.accession);
}

function querySignature(query: GenomeSearchQuery) {
  return createHash('sha256').update(JSON.stringify({
    q: query.q,
    taxonomy: query.taxonomy,
    source: query.source,
    annotation: query.annotation,
    sort: query.sort,
    direction: query.direction,
    limit: query.limit,
  })).digest('base64url').slice(0, 22);
}

function encodeCursor(genome: ReleaseGenome, query: GenomeSearchQuery, releaseId: string) {
  const payload: CursorPayload = {
    v: 2,
    releaseId,
    query: querySignature(query),
    sort: query.sort,
    direction: query.direction,
    value: sortValue(genome, query.sort),
    accession: genome.accession,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value: string, query: GenomeSearchQuery, releaseId: string): CursorPayload {
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (
      payload.v !== 2
      || payload.releaseId !== releaseId
      || payload.query !== querySignature(query)
      || payload.sort !== query.sort
      || payload.direction !== query.direction
      || typeof payload.accession !== 'string'
      || payload.accession.length === 0
      || payload.accession.length > 200
      || !['string', 'number'].includes(typeof payload.value) && payload.value !== null
    ) throw new InvalidGenomeCursorError();
    return payload as CursorPayload;
  } catch (cause) {
    if (cause instanceof InvalidGenomeCursorError) throw cause;
    throw new InvalidGenomeCursorError();
  }
}

function cursorValueMatches(genome: ReleaseGenome, cursor: CursorPayload) {
  return sortValue(genome, cursor.sort) === cursor.value;
}

function uniqueSorted(values: Array<string | null>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort(compareStrings);
}

function buildFacets(genomes: ReleaseGenome[], query: GenomeSearchQuery): GenomeSearchResponse['facets'] {
  const taxonomy = {} as GenomeTaxonomyFacets;
  for (let index = 0; index < TAXONOMY_RANKS.length; index += 1) {
    const rank = TAXONOMY_RANKS[index];
    const eligible = genomes.filter((genome) => TAXONOMY_RANKS
      .slice(0, index)
      .every((parent) => !query.taxonomy[parent.key] || genome[parent.field] === query.taxonomy[parent.key]));
    taxonomy[rank.key] = uniqueSorted(eligible.map((genome) => genome[rank.field] as string | null));
  }
  return {
    sources: uniqueSorted(genomes.map((genome) => genome.genomeSource)),
    taxonomy,
  };
}

function matchesQuery(genome: ReleaseGenome, query: GenomeSearchQuery) {
  const needle = query.q.toLocaleLowerCase().normalize('NFKC');
  const tokens = normalizedTokens(query.q);
  const accessionMatches = !needle || genome.accession.toLocaleLowerCase() === needle || genome.accession.toLocaleLowerCase().startsWith(needle);
  const searchableTokens = normalizedTokens([
    genome.accession,
    genome.organismName,
    genome.strain,
    genome.domain,
    genome.phylum,
    genome.className,
    genome.orderName,
    genome.family,
    genome.genus,
  ].filter(Boolean).join(' '));
  const matchesText = !needle || accessionMatches || (tokens.length > 0 && tokens.every((token) => searchableTokens.some((candidate) => candidate.startsWith(token))));
  const matchesTaxonomy = TAXONOMY_RANKS.every((rank) => !query.taxonomy[rank.key] || genome[rank.field] === query.taxonomy[rank.key]);
  const matchesSource = !query.source || genome.genomeSource === query.source;
  const matchesAnnotation = !query.annotation
    || (query.annotation === 'available' ? genome.annotationStatus === 'available' : genome.annotationStatus !== 'available');
  return matchesText && matchesTaxonomy && matchesSource && matchesAnnotation;
}

class JsonGenomeCatalogRepository implements GenomeCatalogRepository {
  async search(query: GenomeSearchQuery): Promise<GenomeSearchResponse> {
    const result = getReleaseCatalog();
    if (result.status !== 'ready') throw new GenomeCatalogUnavailableError(result.message);

    const filtered = result.catalog.genomes
      .filter((genome) => matchesQuery(genome, query))
      .sort((left, right) => compareGenomes(left, right, query.sort, query.direction));

    let startIndex = 0;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor, query, result.catalog.releaseId);
      const cursorIndex = filtered.findIndex((genome) => genome.accession === cursor.accession && cursorValueMatches(genome, cursor));
      if (cursorIndex < 0) throw new InvalidGenomeCursorError('cursor does not belong to this result set');
      startIndex = cursorIndex + 1;
    }

    const page = filtered.slice(startIndex, startIndex + query.limit);
    const hasNext = startIndex + page.length < filtered.length;
    return {
      releaseId: result.catalog.releaseId,
      items: page.map(toCatalogRow),
      total: filtered.length,
      facets: buildFacets(result.catalog.genomes, query),
      pageInfo: {
        nextCursor: hasNext && page.length ? encodeCursor(page[page.length - 1], query, result.catalog.releaseId) : null,
        hasNext,
      },
    };
  }

  async getByAccession(accession: string): Promise<GenomeCatalogMatch | null> {
    const match = getReleaseGenome(accession);
    return match ? {
      releaseId: match.catalog.releaseId,
      assetBase: assetBaseForAccession(match.genome.accession, match.catalog.assetBase),
      genome: match.genome,
      storage: match.genome.storage || {
        layout: 'individual-v1',
        logicalObjectPrefix: match.genome.accession,
        baseUrl: process.env.HF_STORAGE_BASE_URL || process.env.HF_PILOT_STORAGE_BASE_URL,
      },
    } : null;
  }

  async getActiveRelease(): Promise<ActiveReleaseSummary> {
    const result = getReleaseCatalog();
    if (result.status !== 'ready') throw new GenomeCatalogUnavailableError(result.message);
    const catalog = result.catalog;
    return {
      releaseId: catalog.releaseId,
      sourceReleaseId: null,
      releaseDate: catalog.releaseDate,
      generatedAt: catalog.generatedAt,
      description: catalog.description,
      totalGenomes: catalog.totalGenomes,
      totalPredictedPromoters: catalog.totalPredictedPromoters,
      totalAnnotatedGenomes: catalog.totalAnnotatedGenomes,
      totalDownloadedAnnotations: catalog.totalDownloadedAnnotations,
      totalMissingAnnotations: catalog.totalMissingAnnotations,
      totalIncompatibleAnnotations: catalog.totalIncompatibleAnnotations,
      totalUsableAnnotations: catalog.totalUsableAnnotations,
      totalCircularOriginSplitFeatures: catalog.totalCircularOriginSplitFeatures,
      totalCircularOriginSplitGenomes: catalog.totalCircularOriginSplitGenomes,
      totalExperimentalTss: catalog.totalExperimentalTss,
      topPhyla: catalog.topPhyla,
      releaseAssetBaseUrl: process.env.NEXT_PUBLIC_RELEASE_ASSET_BASE_URL || null,
      manifestIndexPath: null,
    };
  }
}

type D1ReleaseRow = Record<string, string | number | null>;
type D1GenomeRow = Record<string, string | number | null>;
type D1FeatureAggregateRow = {
  feature_type: string;
  status: string;
  genome_count: number;
  feature_count: number | null;
};

async function configuredD1() {
  const requested = process.env.SEQEDGE_CATALOG_BACKEND === 'd1' || process.env.NODE_ENV === 'production';
  if (!requested) return null;
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const database = getCloudflareContext().env.SEQEDGE_DB;
    if (!database) throw new GenomeCatalogUnavailableError('SEQEDGE_DB is not bound to this deployment.');
    return database;
  } catch (cause) {
    if (cause instanceof GenomeCatalogUnavailableError) throw cause;
    throw new GenomeCatalogUnavailableError('Cloudflare D1 catalog context is unavailable.');
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function isSafeObjectPath(value: string) {
  if (!value || value.startsWith('/') || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'));
}

function parseObject(value: unknown, accession: string, label: string) {
  let parsed: unknown;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : null; } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GenomeCatalogUnavailableError(accession + ': ' + label + ' is invalid.');
  }
  return parsed as Record<string, unknown>;
}

function portalAssetPath(value: unknown, accession: string, label: string): string;
function portalAssetPath(value: unknown, accession: string, label: string, optional: true): string | null;
function portalAssetPath(value: unknown, accession: string, label: string, optional = false): string | null {
  if ((value === null || value === undefined) && optional) return null;
  if (typeof value !== 'string' || !isSafeObjectPath(value)) {
    throw new GenomeCatalogUnavailableError(accession + ': ' + label + ' path is invalid.');
  }
  const path = value.startsWith('objects/') ? value.slice('objects/'.length) : value;
  if (!path.startsWith(accession + '/')) {
    throw new GenomeCatalogUnavailableError(accession + ': ' + label + ' path does not match the genome.');
  }
  return path;
}

function parseD1Storage(candidate: Record<string, unknown>, expectedLayout: string, releaseId: string, accession: string): GenomeStorageMap {
  if (
    candidate.layout !== expectedLayout
  ) {
    throw new GenomeCatalogUnavailableError(accession + ': storage layout does not match the active release.');
  }
  const logicalObjectPrefix = typeof candidate.logicalObjectPrefix === 'string'
    ? candidate.logicalObjectPrefix
    : accession;
  if (!isSafeObjectPath(logicalObjectPrefix)) throw new GenomeCatalogUnavailableError(accession + ': storage prefix is invalid.');
  if (candidate.baseUrl !== undefined && (typeof candidate.baseUrl !== 'string' || !candidate.baseUrl.trim())) {
    throw new GenomeCatalogUnavailableError(accession + ': storage base URL is invalid.');
  }
  if (candidate.layout === 'individual-v1') {
    return {
      layout: 'individual-v1',
      logicalObjectPrefix,
      ...(typeof candidate.baseUrl === 'string' ? { baseUrl: candidate.baseUrl } : {}),
    };
  }
  if (candidate.layout !== 'packed-v1' || !candidate.assets || typeof candidate.assets !== 'object' || Array.isArray(candidate.assets)) {
    throw new GenomeCatalogUnavailableError(accession + ': packed storage assets are missing.');
  }
  const assets = Object.entries(candidate.assets as Record<string, unknown>);
  if (assets.length === 0) throw new GenomeCatalogUnavailableError(accession + ': packed storage assets are empty.');
  const expectedPackPrefix = 'releases/' + releaseId + '/packs/';
  for (const [file, rawAsset] of assets) {
    if (!file || !rawAsset || typeof rawAsset !== 'object' || Array.isArray(rawAsset)) {
      throw new GenomeCatalogUnavailableError(accession + '/' + file + ': packed asset is invalid.');
    }
    const asset = rawAsset as Record<string, unknown>;
    if (
      typeof asset.packPath !== 'string'
      || !isSafeObjectPath(asset.packPath)
      || !asset.packPath.startsWith(expectedPackPrefix)
      || !Number.isSafeInteger(asset.offset) || Number(asset.offset) < 0
      || !Number.isSafeInteger(asset.length) || Number(asset.length) < 0
      || typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)
      || typeof asset.contentType !== 'string' || !asset.contentType.trim()
    ) throw new GenomeCatalogUnavailableError(accession + '/' + file + ': packed asset metadata is invalid.');
  }
  return {
    layout: 'packed-v1',
    logicalObjectPrefix,
    ...(typeof candidate.baseUrl === 'string' ? { baseUrl: candidate.baseUrl } : {}),
    assets: candidate.assets as Record<string, PackedAsset>,
  };
}

function rowToGenome(row: D1GenomeRow, expectedLayout: string, expectedReleaseId: string): ReleaseGenome {
  const accession = String(row.accession);
  if (String(row.release_id) !== expectedReleaseId) {
    throw new GenomeCatalogUnavailableError(accession + ': genome release does not match the active release.');
  }
  const referenceStorage = parseObject(row.reference_storage_json, accession, 'reference storage mapping');
  const files = referenceStorage.files && typeof referenceStorage.files === 'object' && !Array.isArray(referenceStorage.files)
    ? referenceStorage.files as Record<string, unknown>
    : null;
  if (expectedLayout === 'individual-v1' && !files) {
    throw new GenomeCatalogUnavailableError(accession + ': reference files are missing.');
  }
  const promoterStorage = parseJson<Record<string, unknown>>(row.promoter_storage_json, {});
  const annotationStorage = parseJson<Record<string, unknown>>(row.annotation_storage_json, {});
  const packedAssets = {
    ...(referenceStorage.assets && typeof referenceStorage.assets === 'object' && !Array.isArray(referenceStorage.assets)
      ? referenceStorage.assets as Record<string, unknown>
      : {}),
    ...(promoterStorage.assets && typeof promoterStorage.assets === 'object' && !Array.isArray(promoterStorage.assets)
      ? promoterStorage.assets as Record<string, unknown>
      : {}),
    ...(annotationStorage.assets && typeof annotationStorage.assets === 'object' && !Array.isArray(annotationStorage.assets)
      ? annotationStorage.assets as Record<string, unknown>
      : {}),
  };
  const storage = parseD1Storage({
    ...referenceStorage,
    ...(expectedLayout === 'packed-v1' ? { assets: packedAssets } : {}),
  }, expectedLayout, expectedReleaseId, accession);
  const assets = {
    fasta: portalAssetPath(files?.fasta ?? accession + '/reference.fa.gz', accession, 'FASTA'),
    fastaFai: portalAssetPath(files?.fai ?? accession + '/reference.fa.gz.fai', accession, 'FASTA index'),
    fastaGzi: portalAssetPath(files?.gzi ?? accession + '/reference.fa.gz.gzi', accession, 'FASTA gzip index'),
    predictedPromoters: portalAssetPath(row.promoter_data_path, accession, 'promoter data'),
    predictedPromotersIndex: portalAssetPath(row.promoter_index_path, accession, 'promoter index'),
    ncbiAnnotations: row.annotation_status === 'ready'
      ? portalAssetPath(row.annotation_data_path, accession, 'annotation data')
      : null,
    ncbiAnnotationsIndex: row.annotation_status === 'ready'
      ? portalAssetPath(row.annotation_index_path, accession, 'annotation index')
      : null,
    metadata: portalAssetPath(files?.metadata, accession, 'metadata', true),
  };
  return {
    accession,
    organismName: String(row.organism_name),
    strain: row.strain as string | null,
    domain: row.domain as string | null,
    phylum: row.phylum as string | null,
    className: row.class_name as string | null,
    orderName: row.order_name as string | null,
    family: row.family as string | null,
    genus: row.genus as string | null,
    genomeSource: row.genome_source as string | null,
    assemblyLevel: row.assembly_level as string | null,
    genomeSizeBp: row.genome_size_bp as number | null,
    gcContent: row.gc_content as number | null,
    contigCount: row.contig_count as number | null,
    completeness: row.completeness as number | null,
    contamination: row.contamination as number | null,
    predictedPromoterCount: Number(row.predicted_promoter_count || 0),
    annotationStatus: row.annotation_status === 'ready' ? 'available' : row.annotation_status === 'failed' ? 'incompatible' : 'missing',
    annotationFeatureCount: Number(row.annotation_feature_count || 0),
    annotationCircularOriginSplitCount: 0,
    experimentalTssCount: 0,
    hasExperimentalTss: false,
    defaultLocus: row.default_locus as string | null,
    primarySequence: row.primary_sequence as string | null,
    assets,
    storage,
  };
}

async function activeD1Release(database: D1Database) {
  const row = await database.prepare("SELECT r.* FROM portal_state p JOIN releases r ON r.release_id = p.active_release_id WHERE p.singleton = 1 AND COALESCE(r.publication_status, 'ready') = 'ready'").first<D1ReleaseRow>();
  if (!row) throw new GenomeCatalogUnavailableError('No active SeqEdge release is configured in D1.');
  return row;
}

const D1_FEATURE_JOINS = [
  "LEFT JOIN feature_sets p ON p.release_id = g.release_id AND p.accession = g.accession AND p.feature_type = 'promoter' AND p.is_default = 1",
  "LEFT JOIN feature_sets a ON a.release_id = g.release_id AND a.accession = g.accession AND a.feature_type = 'gene_annotation' AND a.is_default = 1",
].join(' ');

const D1_GENOME_SELECT = [
  'SELECT g.*',
  ', p.feature_count AS predicted_promoter_count, p.status AS promoter_status',
  ', p.data_path AS promoter_data_path, p.index_path AS promoter_index_path, p.storage_json AS promoter_storage_json',
  ', a.feature_count AS annotation_feature_count, a.status AS annotation_status',
  ', a.data_path AS annotation_data_path, a.index_path AS annotation_index_path, a.storage_json AS annotation_storage_json',
  'FROM genomes g',
  D1_FEATURE_JOINS,
].join(' ');

function normalizedTokens(value: string) {
  return value.toLocaleLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}_.-]+/u).filter(Boolean);
}

function d1Where(query: GenomeSearchQuery, releaseId: string) {
  const clauses = ['g.release_id = ?'];
  const bindings: Array<string | number> = [releaseId];
  const tokens = normalizedTokens(query.q);
  if (query.q) {
    const accession = query.q.toLocaleUpperCase();
    const tokenClauses = tokens.map(() => 'g.accession IN (SELECT st.accession FROM genome_search_terms st WHERE st.release_id = ? AND st.token >= ? AND st.token < ?)');
    clauses.push('(g.accession = ? OR (g.accession >= ? AND g.accession < ?) OR (' + (tokenClauses.length ? tokenClauses.join(' AND ') : '0') + '))');
    bindings.push(accession, accession, accession + '\uffff', ...tokens.flatMap((token) => [releaseId, token, token + '\uffff']));
  }
  const taxonomyFields: Array<[keyof GenomeSearchQuery['taxonomy'], string]> = [['domain', 'domain'], ['phylum', 'phylum'], ['class', 'class_name'], ['order', 'order_name'], ['family', 'family'], ['genus', 'genus']];
  for (const [key, column] of taxonomyFields) if (query.taxonomy[key]) { clauses.push('g.' + column + ' = ?'); bindings.push(query.taxonomy[key]); }
  if (query.source) { clauses.push('g.genome_source = ?'); bindings.push(query.source); }
  if (query.annotation === 'available') clauses.push("a.status = 'ready'");
  else if (query.annotation === 'unavailable') clauses.push("COALESCE(a.status, 'missing') <> 'ready'");
  return { clauses, bindings };
}

function d1Sort(query: GenomeSearchQuery) {
  const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
  if (query.sort === 'organism') return {
    outerExpression: 'filtered.organism_name',
    outerOrder: 'filtered.organism_name ' + direction + ', filtered.accession ASC',
  };
  if (query.sort === 'promoters') return {
    outerExpression: 'COALESCE(filtered.predicted_promoter_count, 0)',
    outerOrder: 'COALESCE(filtered.predicted_promoter_count, 0) ' + direction + ', filtered.accession ASC',
  };
  if (query.sort === 'genome-size') return {
    outerExpression: 'filtered.genome_size_bp',
    outerOrder: 'filtered.genome_size_bp IS NULL ASC, filtered.genome_size_bp ' + direction + ', filtered.accession ASC',
  };
  return {
    outerExpression: 'filtered.accession',
    outerOrder: 'filtered.accession ' + direction,
  };
}

async function d1Facets(database: D1Database, releaseId: string, query: GenomeSearchQuery): Promise<GenomeSearchResponse['facets']> {
  const parents = [query.taxonomy.domain, query.taxonomy.phylum, query.taxonomy.class, query.taxonomy.order, query.taxonomy.family];
  const ranks = ['domain', 'phylum', 'class', 'order', 'family', 'genus'];
  const branches = ["kind = 'source'"];
  const bindings: string[] = [releaseId];
  for (let index = 0; index < ranks.length; index += 1) {
    const clauses = ["kind = ?"];
    const rankBindings = [ranks[index]];
    const columns = ['domain', 'phylum', 'class_name', 'order_name', 'family'];
    for (let parent = 0; parent < index && parent < parents.length; parent += 1) {
      if (parents[parent]) {
        clauses.push(columns[parent] + ' = ?');
        rankBindings.push(parents[parent]);
      }
    }
    branches.push('(' + clauses.join(' AND ') + ')');
    bindings.push(...rankBindings);
  }
  const result = await database
    .prepare('SELECT DISTINCT kind AS facet_kind, value FROM facet_options WHERE release_id = ? AND (' + branches.join(' OR ') + ') ORDER BY facet_kind, value')
    .bind(...bindings)
    .all<{ facet_kind: string; value: string }>();
  const values = Object.fromEntries(['source', ...ranks].map((kind) => [kind, [] as string[]]));
  for (const row of result.results) values[row.facet_kind]?.push(row.value);
  return {
    sources: values.source,
    taxonomy: {
      domain: values.domain,
      phylum: values.phylum,
      class: values.class,
      order: values.order,
      family: values.family,
      genus: values.genus,
    },
  };
}

export class D1GenomeCatalogRepository implements GenomeCatalogRepository {
  constructor(private database: D1Database) {}

  async search(query: GenomeSearchQuery): Promise<GenomeSearchResponse> {
    const release = await activeD1Release(this.database);
    const releaseId = String(release.release_id);
    const where = d1Where(query, releaseId);
    const sort = d1Sort(query);
    const cursorClauses: string[] = [];
    const bindings = [...where.bindings];
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor, query, releaseId);
      const filtered = D1_GENOME_SELECT + ' WHERE ' + where.clauses.join(' AND ');
      const cursorRow = await this.database
        .prepare('WITH filtered AS (' + filtered + ') SELECT ' + sort.outerExpression + ' AS cursor_value FROM filtered WHERE filtered.accession = ?')
        .bind(...where.bindings, cursor.accession)
        .first<{ cursor_value: SortValue }>();
      if (!cursorRow || cursorRow.cursor_value !== cursor.value) throw new InvalidGenomeCursorError('cursor does not belong to this result set');
      const comparison = query.direction === 'asc' ? '>' : '<';
      if (query.sort === 'genome-size' && cursor.value === null) {
        cursorClauses.push('(filtered.genome_size_bp IS NULL AND filtered.accession > ?)');
        bindings.push(cursor.accession);
      } else if (query.sort === 'genome-size') {
        cursorClauses.push('(filtered.genome_size_bp IS NULL OR (filtered.genome_size_bp IS NOT NULL AND ((filtered.genome_size_bp ' + comparison + ' ?) OR (filtered.genome_size_bp = ? AND filtered.accession > ?))))');
        bindings.push(cursor.value as number, cursor.value as number, cursor.accession);
      } else {
        cursorClauses.push('((' + sort.outerExpression + ' ' + comparison + ' ?) OR (' + sort.outerExpression + ' = ? AND filtered.accession > ?))');
        bindings.push(cursor.value as string | number, cursor.value as string | number, cursor.accession);
      }
    }
    const filtered = D1_GENOME_SELECT + ' WHERE ' + where.clauses.join(' AND ');
    const select = 'WITH filtered AS (' + filtered + ') SELECT filtered.*, (SELECT COUNT(*) FROM filtered) AS total_count FROM filtered'
      + (cursorClauses.length ? ' WHERE ' + cursorClauses.join(' AND ') : '')
      + ' ORDER BY ' + sort.outerOrder + ' LIMIT ?';
    const [pageResult, facets] = await Promise.all([
      this.database.prepare(select).bind(...bindings, query.limit + 1).all<D1GenomeRow>(),
      d1Facets(this.database, releaseId, query),
    ]);
    const genomes = pageResult.results.map((row) => rowToGenome(row, String(release.storage_layout), releaseId));
    const hasNext = genomes.length > query.limit;
    const page = genomes.slice(0, query.limit);
    return {
      releaseId,
      items: page.map(toCatalogRow),
      total: Number(pageResult.results[0]?.total_count || 0),
      facets,
      pageInfo: { nextCursor: hasNext && page.length ? encodeCursor(page[page.length - 1], query, releaseId) : null, hasNext },
    };
  }

  async getByAccession(accession: string): Promise<GenomeCatalogMatch | null> {
    const release = await activeD1Release(this.database);
    const row = await this.database.prepare(D1_GENOME_SELECT + ' WHERE g.release_id = ? AND g.accession = ?').bind(String(release.release_id), accession).first<D1GenomeRow>();
    if (!row) return null;
    const genome = rowToGenome(row, String(release.storage_layout), String(release.release_id));
    const releaseVersion = encodeURIComponent(String(release.release_id));
    const versionAsset = (path: string | null) => path
      ? path + (path.includes('?') ? '&' : '?') + 'release=' + releaseVersion
      : null;
    genome.assets = {
      fasta: versionAsset(genome.assets.fasta)!,
      fastaFai: versionAsset(genome.assets.fastaFai)!,
      fastaGzi: versionAsset(genome.assets.fastaGzi)!,
      predictedPromoters: versionAsset(genome.assets.predictedPromoters)!,
      predictedPromotersIndex: versionAsset(genome.assets.predictedPromotersIndex)!,
      ncbiAnnotations: versionAsset(genome.assets.ncbiAnnotations),
      ncbiAnnotationsIndex: versionAsset(genome.assets.ncbiAnnotationsIndex),
      metadata: versionAsset(genome.assets.metadata),
    };
    const releaseBase = String(release.release_asset_base_url || '').replace(/\/+$/, '');
    const repositoryBase = releaseBase.endsWith('/releases/' + String(release.release_id))
      ? releaseBase.slice(0, -('/releases/' + String(release.release_id)).length)
      : releaseBase;
    if (genome.storage) {
      genome.storage.baseUrl = process.env.HF_STORAGE_BASE_URL
        || genome.storage.baseUrl
        || (genome.storage.layout === 'packed-v1' ? repositoryBase : releaseBase + '/objects');
    }
    return { releaseId: String(release.release_id), assetBase: '/api/remote-data', genome, storage: genome.storage! };
  }

  async getActiveRelease(): Promise<ActiveReleaseSummary> {
    const row = await activeD1Release(this.database);
    const releaseId = String(row.release_id);
    const summary = parseJson<Record<string, unknown>>(row.feature_summary_json, {});
    const aggregates = await this.database.prepare(
      'SELECT feature_type, status, COUNT(*) AS genome_count, SUM(feature_count) AS feature_count FROM feature_sets WHERE release_id = ? GROUP BY feature_type, status',
    ).bind(releaseId).all<D1FeatureAggregateRow>();
    const promoterSummary = aggregates.results.find((entry) => entry.feature_type === 'promoter' && entry.status === 'ready');
    const annotationReady = aggregates.results.find((entry) => entry.feature_type === 'gene_annotation' && entry.status === 'ready');
    const annotationMissing = aggregates.results.find((entry) => entry.feature_type === 'gene_annotation' && entry.status === 'missing');
    const annotationFailed = aggregates.results.find((entry) => entry.feature_type === 'gene_annotation' && entry.status === 'failed');
    return {
      releaseId, sourceReleaseId: row.source_release_id as string | null,
      releaseDate: row.release_date as string | null, generatedAt: row.generated_at as string | null,
      description: row.description as string | null, totalGenomes: Number(row.total_genomes),
      totalPredictedPromoters: Number(promoterSummary?.feature_count || 0), totalAnnotatedGenomes: Number(annotationReady?.genome_count || 0),
      totalDownloadedAnnotations: Number(annotationReady?.genome_count || 0) + Number(annotationFailed?.genome_count || 0),
      totalMissingAnnotations: Number(annotationMissing?.genome_count || 0),
      totalIncompatibleAnnotations: Number(annotationFailed?.genome_count || 0), totalUsableAnnotations: Number(annotationReady?.genome_count || 0),
      totalCircularOriginSplitFeatures: Number(summary.totalCircularOriginSplitFeatures || 0),
      totalCircularOriginSplitGenomes: Number(summary.totalCircularOriginSplitGenomes || 0),
      totalExperimentalTss: Number(summary.totalExperimentalTss || 0),
      topPhyla: Array.isArray(summary.topPhyla) ? summary.topPhyla as ActiveReleaseSummary['topPhyla'] : [],
      releaseAssetBaseUrl: row.release_asset_base_url as string | null, manifestIndexPath: row.manifest_index_path as string | null,
    };
  }
}

const jsonRepository = new JsonGenomeCatalogRepository();

export const genomeCatalogRepository: GenomeCatalogRepository = {
  async search(query) { const database = await configuredD1(); return database ? new D1GenomeCatalogRepository(database).search(query) : jsonRepository.search(query); },
  async getByAccession(accession) { const database = await configuredD1(); return database ? new D1GenomeCatalogRepository(database).getByAccession(accession) : jsonRepository.getByAccession(accession); },
  async getActiveRelease() { const database = await configuredD1(); return database ? new D1GenomeCatalogRepository(database).getActiveRelease() : jsonRepository.getActiveRelease(); },
};
