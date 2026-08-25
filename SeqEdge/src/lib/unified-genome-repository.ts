import 'server-only';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  genomeCatalogRepository,
  type GenomeCatalogRepository,
} from '@/lib/genome-catalog-repository';
import { experimentalTssRepository } from '@/lib/experimental-tss-repository';
import type {
  ExperimentalTssGenome,
  ExperimentalTssRepository,
} from '@/types/experimental-tss';
import type {
  GenomeCatalogRow,
  GenomeSearchQuery,
  GenomeTaxonomyRank,
} from '@/types/genome-catalog';
import type {
  UnifiedGenomeAlias,
  UnifiedGenomeEvidenceState,
  UnifiedGenomeMatch,
  UnifiedGenomeReleases,
  UnifiedGenomeRepository,
  UnifiedGenomeRow,
  UnifiedGenomeSearchQuery,
  UnifiedGenomeSearchResponse,
  UnifiedGenomeStats,
} from '@/types/unified-genome';

const ACCESSION_PATTERN = /^(?:GCA|GCF)_\d{9}\.\d+$/;
const TAXONOMY_FIELDS: Array<[GenomeTaxonomyRank, keyof GenomeCatalogRow]> = [
  ['domain', 'domain'],
  ['phylum', 'phylum'],
  ['class', 'className'],
  ['order', 'orderName'],
  ['family', 'family'],
  ['genus', 'genus'],
];

type CompositeRow = UnifiedGenomeRow & {
  assemblyKey: string;
  assemblySource: 'unified' | 'prediction' | 'experimental';
  assemblyCompatibility: NonNullable<UnifiedGenomeRow['assemblyCompatibility']>;
  overlayAllowed: boolean;
  searchText: string;
  sourceValues: string[];
  predictionSearchRow: GenomeCatalogRow | null;
};

interface ExperimentalCompositeSnapshot {
  releases: UnifiedGenomeReleases;
  rows: CompositeRow[];
  stats: UnifiedGenomeStats;
  overlapPredictionAccessions: Set<string>;
  mismatchPredictionAccessions: Set<string>;
}

interface CursorPayload {
  v: 2;
  revision: string;
  query: string;
  predictionCursor: string | null;
  predictionOffset: number;
  experimentalOffset: number;
}

export class UnifiedGenomeCursorError extends Error {
  constructor(message = 'unified genome cursor is invalid') {
    super(message);
    this.name = 'UnifiedGenomeCursorError';
  }
}

export class UnifiedGenomeAliasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifiedGenomeAliasError';
  }
}

export function parseConfiguredUnifiedGenomeAliases(value = process.env.UNIFIED_GENOME_ALIASES_JSON) {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UnifiedGenomeAliasError('UNIFIED_GENOME_ALIASES_JSON must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length > 500) {
    throw new UnifiedGenomeAliasError('UNIFIED_GENOME_ALIASES_JSON must contain at most 500 alias records.');
  }
  return parsed.map((entry, index): UnifiedGenomeAlias => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new UnifiedGenomeAliasError(`Unified genome alias ${index + 1} must be an object.`);
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.canonicalAccession !== 'string'
      || typeof candidate.predictionAccession !== 'string'
      || typeof candidate.experimentalAccession !== 'string'
      || candidate.relation !== 'ncbi_reciprocal'
    ) throw new UnifiedGenomeAliasError(`Unified genome alias ${index + 1} is incomplete.`);
    return {
      canonicalAccession: candidate.canonicalAccession,
      predictionAccession: candidate.predictionAccession,
      experimentalAccession: candidate.experimentalAccession,
      relation: 'ncbi_reciprocal',
    };
  });
}

function compositeRevision(predictionReleaseId: string, experimentalReleaseId: string) {
  return `${predictionReleaseId}:${experimentalReleaseId}`;
}

function normalized(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().trim();
}

function annotationStatus(
  prediction: GenomeCatalogRow | undefined,
  experimental: ExperimentalTssGenome | undefined,
): GenomeCatalogRow['annotationStatus'] {
  const values = [prediction?.annotationStatus, experimental?.annotationStatus];
  if (values.includes('available')) return 'available';
  if (values.includes('incompatible')) return 'incompatible';
  return 'missing';
}

function evidenceState(prediction: boolean, experimental: boolean): UnifiedGenomeEvidenceState {
  if (prediction && experimental) return 'both';
  return prediction ? 'prediction_only' : 'experimental_only';
}

function querySignature(query: UnifiedGenomeSearchQuery) {
  return createHash('sha256').update(JSON.stringify({
    q: query.q,
    taxonomy: query.taxonomy,
    source: query.source,
    annotation: query.annotation,
    evidence: query.evidence,
    sort: query.sort,
    direction: query.direction,
    limit: query.limit,
  })).digest('base64url').slice(0, 22);
}

function encodeCursor(
  state: Pick<CursorPayload, 'predictionCursor' | 'predictionOffset' | 'experimentalOffset'>,
  query: UnifiedGenomeSearchQuery,
  revision: string,
) {
  const payload: CursorPayload = {
    v: 2,
    revision,
    query: querySignature(query),
    ...state,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value: string, query: UnifiedGenomeSearchQuery, revision: string) {
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (
      payload.v !== 2
      || payload.revision !== revision
      || payload.query !== querySignature(query)
      || payload.predictionCursor !== null && typeof payload.predictionCursor !== 'string'
      || !Number.isSafeInteger(payload.predictionOffset) || Number(payload.predictionOffset) < 0 || Number(payload.predictionOffset) > 100
      || !Number.isSafeInteger(payload.experimentalOffset) || Number(payload.experimentalOffset) < 0 || Number(payload.experimentalOffset) > 100_000
    ) throw new UnifiedGenomeCursorError();
    return payload as CursorPayload;
  } catch (cause) {
    if (cause instanceof UnifiedGenomeCursorError) throw cause;
    throw new UnifiedGenomeCursorError();
  }
}

function compareNullableNumbers(left: number | null, right: number | null) {
  if (left === null && right !== null) return 1;
  if (left !== null && right === null) return -1;
  return (left || 0) - (right || 0);
}

function compareRows(left: UnifiedGenomeRow, right: UnifiedGenomeRow, query: UnifiedGenomeSearchQuery) {
  let primary = 0;
  if (query.sort === 'organism') primary = left.organismName.localeCompare(right.organismName);
  else if (query.sort === 'genome-size') {
    if (left.genomeSizeBp === null || right.genomeSizeBp === null) {
      primary = compareNullableNumbers(left.genomeSizeBp, right.genomeSizeBp);
      return primary || left.canonicalAccession.localeCompare(right.canonicalAccession);
    }
    primary = left.genomeSizeBp - right.genomeSizeBp;
  }
  else if (query.sort === 'promoters') primary = left.predictedPromoterCount - right.predictedPromoterCount;
  else primary = left.canonicalAccession.localeCompare(right.canonicalAccession);
  const directed = primary * (query.direction === 'asc' ? 1 : -1);
  return directed || left.canonicalAccession.localeCompare(right.canonicalAccession);
}

function evidenceMatches(state: UnifiedGenomeEvidenceState, filter: UnifiedGenomeSearchQuery['evidence']) {
  if (filter === 'all') return true;
  if (filter === 'predictions') return state !== 'experimental_only';
  if (filter === 'experimental') return state !== 'prediction_only';
  return state === 'both';
}

function rowMatches(row: CompositeRow, query: UnifiedGenomeSearchQuery, includeEvidence: boolean) {
  const needle = normalized(query.q);
  if (needle && !row.searchText.includes(needle)) return false;
  if (query.source && !row.sourceValues.includes(query.source)) return false;
  if (query.annotation === 'available' && row.annotationStatus !== 'available') return false;
  if (query.annotation === 'unavailable' && row.annotationStatus === 'available') return false;
  if (TAXONOMY_FIELDS.some(([rank, field]) => query.taxonomy[rank] && row[field] !== query.taxonomy[rank])) return false;
  return !includeEvidence || evidenceMatches(row.evidenceState, query.evidence);
}

function uniqueSorted(values: Array<string | null>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
}

function publicRow(row: CompositeRow): UnifiedGenomeRow {
  const result = { ...row };
  delete (result as Partial<CompositeRow>).searchText;
  delete (result as Partial<CompositeRow>).sourceValues;
  delete (result as Partial<CompositeRow>).predictionSearchRow;
  return result;
}

function predictionRowFromMatch(match: Awaited<ReturnType<GenomeCatalogRepository['getByAccession']>>): GenomeCatalogRow | null {
  if (!match) return null;
  const genome = match.genome;
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

function compositeRow(
  canonicalAccession: string,
  predictionRow?: GenomeCatalogRow,
  experimentalGenome?: ExperimentalTssGenome,
  compatibility: NonNullable<UnifiedGenomeRow['assemblyCompatibility']> = predictionRow && experimentalGenome ? 'mismatch' : 'single_source',
): CompositeRow {
  const studies = experimentalGenome?.studies || [];
  const aliases = uniqueSorted([canonicalAccession, predictionRow?.accession || null, experimentalGenome?.accession || null]);
  const sourceValues = uniqueSorted([
    predictionRow?.genomeSource || null,
    experimentalGenome ? 'NCBI RefSeq' : null,
  ]);
  const organismName = predictionRow?.organismName || experimentalGenome?.organismName || canonicalAccession;
  const strain = predictionRow?.strain ?? experimentalGenome?.strain ?? null;
  const assemblySource = predictionRow && experimentalGenome ? 'unified'
    : predictionRow ? 'prediction' : 'experimental';
  return {
    assemblyKey: compatibility === 'mismatch' ? `${canonicalAccession}::${assemblySource}` : canonicalAccession,
    assemblySource,
    canonicalAccession,
    accession: canonicalAccession,
    aliases,
    predictionAccession: predictionRow?.accession || null,
    experimentalAccession: experimentalGenome?.accession || null,
    evidenceState: evidenceState(Boolean(predictionRow), Boolean(experimentalGenome)),
    organismName,
    strain,
    domain: predictionRow?.domain || null,
    phylum: predictionRow?.phylum || null,
    className: predictionRow?.className || null,
    orderName: predictionRow?.orderName || null,
    family: predictionRow?.family || null,
    genus: predictionRow?.genus || null,
    genomeSource: predictionRow?.genomeSource || (experimentalGenome ? 'NCBI RefSeq' : null),
    genomeSizeBp: predictionRow?.genomeSizeBp ?? experimentalGenome?.genomeSizeBp ?? null,
    contigCount: predictionRow?.contigCount ?? experimentalGenome?.contigCount ?? null,
    predictedPromoterCount: predictionRow?.predictedPromoterCount || 0,
    experimentalObservationCount: studies.reduce((sum, study) => sum + study.recordCount, 0),
    experimentalStudyCount: studies.length,
    assemblyCompatibility: compatibility,
    overlayAllowed: compatibility === 'exact' || compatibility === 'reciprocal_alias',
    annotationStatus: annotationStatus(predictionRow, experimentalGenome),
    sourceValues,
    predictionSearchRow: predictionRow || null,
    searchText: normalized([
      canonicalAccession, ...aliases, organismName, strain, ...sourceValues,
      ...studies.flatMap((study) => [
        study.studyId, study.pmid, study.year, study.publication.title,
        study.publication.journal, study.publication.doi,
      ]),
    ].filter(Boolean).join(' ')),
  };
}

function predictionRowMatches(row: GenomeCatalogRow, query: UnifiedGenomeSearchQuery) {
  const tokens = normalized(query.q).split(/[^\p{L}\p{N}_.-]+/u).filter(Boolean);
  const accession = normalized(row.accession);
  const searchable = [
    row.accession, row.organismName, row.strain, row.domain, row.phylum,
    row.className, row.orderName, row.family, row.genus,
  ].filter(Boolean).flatMap((value) => normalized(String(value)).split(/[^\p{L}\p{N}_.-]+/u).filter(Boolean));
  if (tokens.length && !(accession === normalized(query.q) || accession.startsWith(normalized(query.q))
    || tokens.every((token) => searchable.some((candidate) => candidate.startsWith(token))))) return false;
  if (query.source && row.genomeSource !== query.source) return false;
  if (query.annotation === 'available' && row.annotationStatus !== 'available') return false;
  if (query.annotation === 'unavailable' && row.annotationStatus === 'available') return false;
  return !TAXONOMY_FIELDS.some(([rank, field]) => query.taxonomy[rank] && row[field] !== query.taxonomy[rank]);
}

export class CompositeUnifiedGenomeRepository implements UnifiedGenomeRepository {
  private readonly canonicalByAccession = new Map<string, string>();
  private readonly aliasByCanonical = new Map<string, UnifiedGenomeAlias>();
  private experimentalSnapshotCache: { expiresAt: number; value: Promise<ExperimentalCompositeSnapshot> } | null = null;

  constructor(
    private readonly predictionRepository: GenomeCatalogRepository,
    private readonly experimentalRepository: ExperimentalTssRepository,
    aliases: UnifiedGenomeAlias[] = [],
  ) {
    for (const alias of aliases) this.addAlias(alias);
  }

  private addAlias(alias: UnifiedGenomeAlias) {
    if (
      alias.relation !== 'ncbi_reciprocal'
      || !ACCESSION_PATTERN.test(alias.canonicalAccession)
      || !ACCESSION_PATTERN.test(alias.predictionAccession)
      || !ACCESSION_PATTERN.test(alias.experimentalAccession)
      || alias.predictionAccession === alias.experimentalAccession
      || ![alias.predictionAccession, alias.experimentalAccession].includes(alias.canonicalAccession)
    ) throw new UnifiedGenomeAliasError('A reciprocal alias must name two distinct accessions and choose one as canonical.');
    if (this.aliasByCanonical.has(alias.canonicalAccession)) {
      throw new UnifiedGenomeAliasError(`Duplicate canonical accession: ${alias.canonicalAccession}`);
    }
    for (const accession of [alias.predictionAccession, alias.experimentalAccession]) {
      if (this.canonicalByAccession.has(accession)) throw new UnifiedGenomeAliasError(`Accession belongs to multiple aliases: ${accession}`);
      this.canonicalByAccession.set(accession, alias.canonicalAccession);
    }
    this.aliasByCanonical.set(alias.canonicalAccession, alias);
  }

  resolveCanonicalAccession(accession: string) {
    if (!ACCESSION_PATTERN.test(accession)) return null;
    return this.canonicalByAccession.get(accession) || accession;
  }

  private compatibility(
    canonicalAccession: string,
    prediction: Awaited<ReturnType<GenomeCatalogRepository['getByAccession']>>,
    experimental: ExperimentalTssGenome | null,
  ): NonNullable<UnifiedGenomeRow['assemblyCompatibility']> {
    if (!prediction || !experimental) return 'single_source';
    const predictionSha256 = prediction.referenceSha256 || prediction.details?.referenceSha256 || null;
    const referencesMatch = predictionSha256 !== null
      && experimental.referenceSha256 !== null
      && experimental.referenceSha256 !== undefined
      && predictionSha256 === experimental.referenceSha256;
    if (!referencesMatch) return 'mismatch';
    return this.aliasByCanonical.has(canonicalAccession) ? 'reciprocal_alias'
      : prediction.genome.accession === experimental.accession ? 'exact' : 'mismatch';
  }

  private async buildExperimentalSnapshot(): Promise<ExperimentalCompositeSnapshot> {
    const [predictionRelease, experimentalRelease, experimentalGenomes] = await Promise.all([
      this.predictionRepository.getActiveRelease(),
      this.experimentalRepository.getActiveRelease(),
      this.experimentalRepository.listGenomes(),
    ]);
    if (experimentalGenomes.some((genome) => genome.releaseId !== experimentalRelease.releaseId)) {
      throw new Error('Experimental release changed while the unified catalog was being read.');
    }
    const releases = {
      predictionReleaseId: predictionRelease.releaseId,
      experimentalReleaseId: experimentalRelease.releaseId,
      compositeRevision: compositeRevision(predictionRelease.releaseId, experimentalRelease.releaseId),
    };
    const rows = await Promise.all(experimentalGenomes.map(async (genome) => {
      const canonical = this.resolveCanonicalAccession(genome.accession)!;
      const alias = this.aliasByCanonical.get(canonical);
      const predictionAccession = alias?.predictionAccession || canonical;
      const match = await this.predictionRepository.getByAccession(predictionAccession);
      if (match && match.releaseId !== predictionRelease.releaseId) {
        throw new Error('Prediction release changed while experimental evidence was being composed.');
      }
      const compatibility = this.compatibility(canonical, match, genome);
      return compatibility === 'mismatch'
        ? compositeRow(canonical, undefined, genome, 'mismatch')
        : compositeRow(canonical, predictionRowFromMatch(match) || undefined, genome, compatibility);
    }));
    if (new Set(rows.map((row) => row.canonicalAccession)).size !== rows.length) {
      throw new UnifiedGenomeAliasError('Multiple experimental genomes resolve to one canonical accession.');
    }
    const bothGenomes = rows.filter((row) => row.evidenceState === 'both').length;
    const stats: UnifiedGenomeStats = {
      totalGenomes: predictionRelease.totalGenomes + experimentalRelease.genomes - bothGenomes,
      predictionGenomes: predictionRelease.totalGenomes,
      experimentalGenomes: experimentalRelease.genomes,
      bothGenomes,
      totalPredictedPromoters: predictionRelease.totalPredictedPromoters,
      totalExperimentalObservations: experimentalRelease.observations,
      totalExperimentalStudies: experimentalRelease.studies,
      totalExperimentalPublications: experimentalRelease.publications,
    };
    return {
      releases,
      rows,
      stats,
      overlapPredictionAccessions: new Set(rows.flatMap((row) => row.predictionAccession ? [row.predictionAccession] : [])),
      mismatchPredictionAccessions: new Set(rows.flatMap((row) => {
        if (row.assemblyCompatibility !== 'mismatch') return [];
        const alias = this.aliasByCanonical.get(row.canonicalAccession);
        return [alias?.predictionAccession || row.canonicalAccession];
      })),
    };
  }

  private async experimentalSnapshot(): Promise<ExperimentalCompositeSnapshot> {
    if (this.experimentalSnapshotCache && this.experimentalSnapshotCache.expiresAt > Date.now()) return this.experimentalSnapshotCache.value;
    const value = this.buildExperimentalSnapshot();
    this.experimentalSnapshotCache = { expiresAt: Date.now() + 30_000, value };
    try {
      return await value;
    } catch (cause) {
      if (this.experimentalSnapshotCache?.value === value) this.experimentalSnapshotCache = null;
      throw cause;
    }
  }

  async search(query: UnifiedGenomeSearchQuery): Promise<UnifiedGenomeSearchResponse> {
    const snapshot = await this.experimentalSnapshot();
    const cursor = query.cursor ? decodeCursor(query.cursor, query, snapshot.releases.compositeRevision) : {
      predictionCursor: null, predictionOffset: 0, experimentalOffset: 0,
    };
    let predictionCursor = cursor.predictionCursor;
    let predictionOffset = cursor.predictionOffset;
    let predictionPage: Awaited<ReturnType<GenomeCatalogRepository['search']>> | null = null;
    let predictionMetadata: Awaited<ReturnType<GenomeCatalogRepository['search']>> | null = null;
    const predictionQuery = (pageCursor: string | null): GenomeSearchQuery => ({
      q: query.q,
      taxonomy: query.taxonomy,
      source: query.source,
      annotation: query.annotation,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: pageCursor,
    });
    const peekPrediction = async (): Promise<CompositeRow | null> => {
      while (true) {
        if (!predictionPage) {
          predictionPage = await this.predictionRepository.search(predictionQuery(predictionCursor));
          predictionMetadata ||= predictionPage;
          if (predictionPage.releaseId !== snapshot.releases.predictionReleaseId) {
            throw new Error('Prediction release changed while the unified catalog was being read.');
          }
          if (predictionOffset > predictionPage.items.length) throw new UnifiedGenomeCursorError();
        }
        while (predictionOffset < predictionPage.items.length) {
          const row = predictionPage.items[predictionOffset];
          if (!snapshot.overlapPredictionAccessions.has(row.accession)) {
            return compositeRow(
              this.resolveCanonicalAccession(row.accession)!,
              row,
              undefined,
              snapshot.mismatchPredictionAccessions.has(row.accession) ? 'mismatch' : 'single_source',
            );
          }
          predictionOffset += 1;
        }
        if (!predictionPage.pageInfo.nextCursor) return null;
        predictionCursor = predictionPage.pageInfo.nextCursor;
        predictionOffset = 0;
        predictionPage = null;
      }
    };
    const consumePrediction = () => { predictionOffset += 1; };

    const beforeEvidence = snapshot.rows.filter((row) => rowMatches(row, query, false));
    const experimentalRows = beforeEvidence.filter((row) => evidenceMatches(row.evidenceState, query.evidence))
      .sort((left, right) => compareRows(left, right, query));
    let experimentalOffset = cursor.experimentalOffset;
    if (experimentalOffset > experimentalRows.length) throw new UnifiedGenomeCursorError();
    const includePrediction = query.evidence === 'all' || query.evidence === 'predictions';
    let nextPrediction = await peekPrediction();
    const metadata = predictionMetadata!;
    const overlapPredictionMatches = snapshot.rows.filter((row) => row.predictionSearchRow
      && predictionRowMatches(row.predictionSearchRow, query)).length;
    const predictionOnlyTotal = Math.max(0, metadata.total - overlapPredictionMatches);
    const bothCount = beforeEvidence.filter((row) => row.evidenceState === 'both').length;
    const experimentalOnlyCount = beforeEvidence.filter((row) => row.evidenceState === 'experimental_only').length;
    const total = query.evidence === 'both' ? bothCount
      : query.evidence === 'experimental' ? bothCount + experimentalOnlyCount
        : query.evidence === 'predictions' ? predictionOnlyTotal + bothCount
          : predictionOnlyTotal + bothCount + experimentalOnlyCount;
    const items: CompositeRow[] = [];
    while (items.length < query.limit) {
      const nextExperimental = experimentalRows[experimentalOffset] || null;
      const usePrediction = includePrediction && nextPrediction
        && (!nextExperimental || compareRows(nextPrediction, nextExperimental, query) <= 0);
      if (usePrediction && nextPrediction) {
        items.push(nextPrediction);
        consumePrediction();
        nextPrediction = await peekPrediction();
      } else if (nextExperimental) {
        items.push(nextExperimental);
        experimentalOffset += 1;
      } else break;
    }
    const hasNext = experimentalOffset < experimentalRows.length || Boolean(includePrediction && nextPrediction);
    const taxonomy = Object.fromEntries(TAXONOMY_FIELDS.map(([rank, field]) => [
      rank,
      uniqueSorted([
        ...metadata.facets.taxonomy[rank],
        ...snapshot.rows.map((row) => row[field] as string | null),
      ]),
    ])) as UnifiedGenomeSearchResponse['facets']['taxonomy'];
    return {
      releases: snapshot.releases,
      items: items.map(publicRow),
      total,
      facets: {
        sources: uniqueSorted([...metadata.facets.sources, ...snapshot.rows.flatMap((row) => row.sourceValues)]),
        taxonomy,
        evidence: {
          prediction_only: predictionOnlyTotal,
          experimental_only: experimentalOnlyCount,
          both: bothCount,
        },
      },
      stats: snapshot.stats,
      pageInfo: {
        nextCursor: hasNext && items.length ? encodeCursor({
          predictionCursor,
          predictionOffset,
          experimentalOffset,
        }, query, snapshot.releases.compositeRevision) : null,
        hasNext,
      },
    };
  }

  async getByAccession(
    accession: string,
    assemblySource?: 'prediction' | 'experimental',
  ): Promise<UnifiedGenomeMatch | null> {
    const canonicalAccession = this.resolveCanonicalAccession(accession);
    if (!canonicalAccession) return null;
    const alias = this.aliasByCanonical.get(canonicalAccession);
    const predictionAccession = alias?.predictionAccession || canonicalAccession;
    const experimentalAccession = alias?.experimentalAccession || canonicalAccession;
    const [prediction, experimental, predictionRelease, experimentalRelease] = await Promise.all([
      this.predictionRepository.getByAccession(predictionAccession),
      this.experimentalRepository.getGenome(experimentalAccession),
      this.predictionRepository.getActiveRelease(),
      this.experimentalRepository.getActiveRelease(),
    ]);
    if (!prediction && !experimental) return null;
    const releases = {
      predictionReleaseId: predictionRelease.releaseId,
      experimentalReleaseId: experimentalRelease.releaseId,
      compositeRevision: compositeRevision(predictionRelease.releaseId, experimentalRelease.releaseId),
    };
    const aliases = uniqueSorted([
      canonicalAccession,
      prediction?.genome.accession || null,
      experimental?.accession || null,
    ]);
    const assemblyCompatibility = this.compatibility(canonicalAccession, prediction, experimental);
    const availableAssemblySources = [
      ...(prediction ? ['prediction' as const] : []),
      ...(experimental ? ['experimental' as const] : []),
    ];
    let selectedPrediction = prediction;
    let selectedExperimental = experimental;
    if (assemblyCompatibility === 'mismatch') {
      const selectedSource = assemblySource
        || (alias && accession === alias.experimentalAccession ? 'experimental' : 'prediction');
      if (selectedSource === 'experimental') selectedPrediction = null;
      else selectedExperimental = null;
    }
    return {
      canonicalAccession,
      aliases,
      evidenceState: evidenceState(Boolean(selectedPrediction), Boolean(selectedExperimental)),
      assemblyCompatibility,
      overlayAllowed: assemblyCompatibility === 'exact' || assemblyCompatibility === 'reciprocal_alias',
      availableAssemblySources,
      prediction: selectedPrediction,
      experimental: selectedExperimental,
      releases,
    };
  }

  async getStats() {
    const snapshot = await this.experimentalSnapshot();
    return { releases: snapshot.releases, stats: snapshot.stats };
  }
}

export const unifiedGenomeRepository: UnifiedGenomeRepository = new CompositeUnifiedGenomeRepository(
  genomeCatalogRepository,
  experimentalTssRepository,
  parseConfiguredUnifiedGenomeAliases(),
);
