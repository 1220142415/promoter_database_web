import 'server-only';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ExperimentalAnnotationStatus,
  ExperimentalPublication,
  ExperimentalResolvedAsset,
  ExperimentalTssGenome,
  ExperimentalTssReleaseSummary,
  ExperimentalTssRepository,
  ExperimentalTssStudy,
  ExperimentalTssStudySearchResponse,
} from '@/types/experimental-tss';

const ACCESSION_PATTERN = /^GCF_\d{9}\.\d+$/;
const STUDY_PATTERN = /^\d{4}_\d+_GCF_\d{9}\.\d+$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type JsonObject = Record<string, unknown>;
type CatalogGenome = JsonObject & { accession: string; studies: string[] };
type CatalogStudy = JsonObject & { studyId: string; gcf: string };
type NormalizedCatalog = {
  releaseKind: 'experimental_tss';
  releaseId: string;
  generatedAt: string | null;
  description: string | null;
  assetBase: string | null;
  summary: ExperimentalTssReleaseSummary;
  studies: CatalogStudy[];
  genomes: CatalogGenome[];
};

export class ExperimentalTssCatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentalTssCatalogUnavailableError';
  }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function integerValue(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function parseJsonObject(value: unknown): JsonObject {
  if (typeof value !== 'string') return objectValue(value);
  try { return objectValue(JSON.parse(value)); } catch { return {}; }
}

function safeAssetPath(value: unknown, label: string): string {
  const path = stringValue(value);
  if (!path || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new ExperimentalTssCatalogUnavailableError(`${label} is not a safe release path.`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !SAFE_PATH_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    throw new ExperimentalTssCatalogUnavailableError(`${label} is not a safe release path.`);
  }
  return path;
}

function optionalAssetPath(value: unknown, label: string) {
  return value === null || value === undefined || value === '' ? null : safeAssetPath(value, label);
}

function publicationFrom(value: unknown, fallback: JsonObject = {}): ExperimentalPublication {
  const publication = objectValue(value);
  const rawAuthors = publication.authors ?? fallback.authors;
  const authors = Array.isArray(rawAuthors)
    ? rawAuthors.map(stringValue).filter((author): author is string => Boolean(author))
    : stringValue(rawAuthors)?.split(/\s*;\s*/).filter(Boolean) || [];
  const status = stringValue(publication.status ?? fallback.publicationStatus);
  return {
    title: stringValue(publication.title ?? fallback.title),
    authors,
    journal: stringValue(publication.journal ?? fallback.journal),
    doi: stringValue(publication.doi ?? fallback.doi),
    status: status === 'resolved' || status === 'unresolved' || status === 'unavailable'
      ? status
      : stringValue(publication.title ?? fallback.title) ? 'resolved' : 'unresolved',
  };
}

function checksumMap(value: unknown) {
  const checksums = objectValue(value);
  return Object.fromEntries(Object.entries(checksums)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[0-9a-f]{64}$/.test(entry[1])));
}

function normalizeStudy(study: JsonObject, genome: JsonObject): ExperimentalTssStudy {
  const studyId = stringValue(study.studyId ?? study.study_id ?? study.definition_id ?? study.source_id);
  const accession = stringValue(study.gcf ?? study.accession ?? genome.accession);
  const pmid = stringValue(study.pmid);
  const year = integerValue(study.year);
  const recordCount = integerValue(study.recordCount ?? study.record_count ?? study.feature_count);
  if (!studyId || !STUDY_PATTERN.test(studyId) || !accession || !ACCESSION_PATTERN.test(accession) || !pmid || !/^\d+$/.test(pmid) || year === null || recordCount === null || recordCount < 0) {
    throw new ExperimentalTssCatalogUnavailableError('An experimental study record is invalid.');
  }
  const assets = objectValue(study.assets);
  const provenance = objectValue(study.provenance);
  const rawBed = safeAssetPath(assets.rawBed ?? assets.raw_bed ?? provenance.rawBedPath ?? provenance.raw_bed_path, `${studyId} raw BED path`);
  const data = safeAssetPath(assets.data ?? study.data_path, `${studyId} GFF3 path`);
  const index = optionalAssetPath(assets.index ?? study.index_path, `${studyId} GFF3 index path`);
  const checksums = checksumMap(study.checksums);
  const duplicateGroupCount = integerValue(study.duplicateGroupCount ?? provenance.duplicateGroupCount ?? provenance.duplicate_group_count);
  return {
    studyId,
    datasetRow: integerValue(study.datasetRow ?? study.dataset_row ?? provenance.datasetRow ?? provenance.dataset_row),
    accession,
    organismName: stringValue(study.organismName ?? genome.organismName ?? genome.organism_name) || accession,
    pmid,
    year,
    recordCount,
    sourceFile: stringValue(study.sourceFile ?? study.source_file ?? provenance.sourceFile ?? provenance.source_file),
    sourceSha256: stringValue(study.sourceSha256 ?? study.source_sha256 ?? provenance.sourceSha256 ?? provenance.source_sha256),
    duplicateGroupCount,
    publication: publicationFrom(study.publication, study),
    assets: { rawBed, data, index },
    checksums,
  };
}

function parseCatalog(value: unknown): NormalizedCatalog {
  const catalog = objectValue(value);
  if (catalog.releaseKind !== 'experimental_tss' || !Array.isArray(catalog.studies) || !Array.isArray(catalog.genomes)) {
    throw new ExperimentalTssCatalogUnavailableError('The experimental TSS catalog has an unsupported schema.');
  }
  const releaseId = stringValue(catalog.releaseId);
  if (!releaseId) throw new ExperimentalTssCatalogUnavailableError('The experimental TSS release ID is missing.');
  const genomes = catalog.genomes.map((value) => {
    const genome = objectValue(value);
    const accession = stringValue(genome.accession);
    const studyIds = Array.isArray(genome.studies) ? genome.studies.map(stringValue).filter((id): id is string => Boolean(id)) : [];
    if (!accession || !ACCESSION_PATTERN.test(accession)) throw new ExperimentalTssCatalogUnavailableError('An experimental genome accession is invalid.');
    return { ...genome, accession, studies: studyIds };
  });
  const genomeByAccession = new Map(genomes.map((genome) => [genome.accession, genome]));
  const studies: CatalogStudy[] = catalog.studies.map((value) => {
    const study = objectValue(value);
    const studyId = stringValue(study.studyId);
    const gcf = stringValue(study.gcf ?? study.accession);
    if (!studyId || !gcf || !genomeByAccession.has(gcf)) throw new ExperimentalTssCatalogUnavailableError('An experimental study references an unknown genome.');
    normalizeStudy(study, genomeByAccession.get(gcf) || {});
    return { ...study, studyId, gcf };
  });
  const summary = objectValue(catalog.summary);
  const years = [...new Set(studies.map((study) => integerValue(study.year)).filter((year): year is number => year !== null))].sort((a, b) => a - b);
  return {
    releaseKind: 'experimental_tss',
    releaseId,
    generatedAt: stringValue(catalog.generatedAt),
    description: stringValue(catalog.description),
    assetBase: stringValue(catalog.assetBase),
    summary: {
      releaseId,
      generatedAt: stringValue(catalog.generatedAt),
      description: stringValue(catalog.description),
      studies: integerValue(summary.studies) ?? studies.length,
      genomes: integerValue(summary.genomes) ?? genomes.length,
      publications: integerValue(summary.publications) ?? new Set(studies.map((study) => stringValue(study.pmid))).size,
      observations: integerValue(summary.observations) ?? studies.reduce((total, study) => total + (integerValue(study.recordCount) || 0), 0),
      years,
    },
    studies,
    genomes,
  };
}

function configuredAssetBase(catalogBase: string | null) {
  return stringValue(process.env.EXPERIMENTAL_TSS_STORAGE_BASE_URL) || catalogBase;
}

function upstreamUrl(base: string | null, path: string) {
  if (!base) throw new ExperimentalTssCatalogUnavailableError('Experimental TSS storage is not configured.');
  let root: URL;
  try { root = new URL(base.endsWith('/') ? base : `${base}/`); } catch {
    throw new ExperimentalTssCatalogUnavailableError('Experimental TSS storage URL is invalid.');
  }
  if (!['http:', 'https:'].includes(root.protocol)) throw new ExperimentalTssCatalogUnavailableError('Experimental TSS storage URL is invalid.');
  const url = new URL(path.split('/').map(encodeURIComponent).join('/'), root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw new ExperimentalTssCatalogUnavailableError('Experimental TSS asset escaped its release root.');
  return url.toString();
}

function logicalStudyPrefix(studyId: string) {
  return `studies/${studyId}`;
}

function toProxyStudy(study: ExperimentalTssStudy): ExperimentalTssStudy {
  const prefix = logicalStudyPrefix(study.studyId);
  return { ...study, assets: {
    rawBed: `${prefix}/raw.bed`,
    data: `${prefix}/experimental-tss.gff3.gz`,
    index: study.assets.index ? `${prefix}/experimental-tss.gff3.gz.tbi` : null,
  } };
}

function normalizeAnnotationStatus(value: unknown): ExperimentalAnnotationStatus {
  return value === 'available' ? 'available' : value === 'incompatible' ? 'incompatible' : 'missing';
}

function buildGenome(catalog: NormalizedCatalog, genome: CatalogGenome): ExperimentalTssGenome {
  const annotation = objectValue(genome.annotation);
  const reference = objectValue(genome.referenceStorage ?? genome.reference_storage);
  const referenceChecksums = checksumMap(reference.checksums);
  const annotationStatus = normalizeAnnotationStatus(annotation.status ?? genome.annotationStatus ?? genome.annotation_status);
  const studyById = new Map(catalog.studies.map((study) => [study.studyId, study]));
  const studies = genome.studies.map((id) => studyById.get(id)).filter((study): study is CatalogStudy => Boolean(study))
    .map((study) => toProxyStudy(normalizeStudy(study, genome)));
  const primarySequence = stringValue(genome.primarySequence ?? genome.primary_sequence);
  return {
    releaseId: catalog.releaseId,
    accession: genome.accession,
    organismName: stringValue(genome.organismName ?? genome.organism_name) || genome.accession,
    strain: stringValue(genome.strain),
    assemblyName: stringValue(genome.assemblyName ?? genome.assembly_name),
    genbankAssemblyAccession: stringValue(genome.genbankAssemblyAccession ?? genome.genbank_assembly_accession),
    defaultLocus: stringValue(genome.defaultLocus ?? genome.default_locus) || `${primarySequence || genome.accession}:1-10000`,
    primarySequence,
    genomeSizeBp: integerValue(genome.genomeSizeBp ?? genome.genome_size_bp),
    contigCount: integerValue(genome.contigCount ?? genome.contig_count),
    annotationStatus,
    referenceSha256: referenceChecksums.fasta || null,
    assetBase: `/api/experimental-data/${genome.accession}`,
    assets: {
      fasta: 'reference.fa.gz',
      fastaFai: 'reference.fa.gz.fai',
      fastaGzi: 'reference.fa.gz.gzi',
      ncbiAnnotations: annotationStatus === 'available' && annotation.data ? 'ncbi-annotations.gff3.gz' : null,
      ncbiAnnotationsIndex: annotationStatus === 'available' && annotation.index ? 'ncbi-annotations.gff3.gz.tbi' : null,
    },
    studies,
  };
}

function normalizedSearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().trim();
}

function searchStudies(studies: ExperimentalTssStudy[], query: { q?: string; year?: number | null } = {}) {
  const needle = normalizedSearch(query.q || '');
  return studies.filter((study) => {
    if (query.year && study.year !== query.year) return false;
    if (!needle) return true;
    return normalizedSearch([
      study.studyId, study.accession, study.organismName, study.pmid, study.year,
      study.publication.title, study.publication.journal, study.publication.doi,
    ].filter(Boolean).join(' ')).includes(needle);
  });
}

function findCatalogAsset(catalog: NormalizedCatalog, accession: string, logicalAsset: string) {
  const genome = catalog.genomes.find((item) => item.accession === accession);
  if (!genome) return null;
  const reference = objectValue(genome.referenceStorage ?? genome.reference_storage);
  const files = objectValue(reference.files);
  const referenceChecksums = checksumMap(reference.checksums);
  const annotation = objectValue(genome.annotation);
  const annotationChecksums = checksumMap(annotation.checksums);
  const fixed: Record<string, { path: unknown; sha256?: string; kind: ExperimentalResolvedAsset['kind']; contentType: string; filename: string }> = {
    'reference.fa.gz': { path: files.fasta, sha256: referenceChecksums.fasta, kind: 'reference', contentType: 'application/gzip', filename: `${accession}.reference.fa.gz` },
    'reference.fa.gz.fai': { path: files.fai, sha256: referenceChecksums.fai, kind: 'reference', contentType: 'text/plain; charset=utf-8', filename: `${accession}.reference.fa.gz.fai` },
    'reference.fa.gz.gzi': { path: files.gzi, sha256: referenceChecksums.gzi, kind: 'reference', contentType: 'application/octet-stream', filename: `${accession}.reference.fa.gz.gzi` },
    'ncbi-annotations.gff3.gz': { path: annotation.data, sha256: annotationChecksums.data, kind: 'annotation', contentType: 'application/gzip', filename: `${accession}.ncbi-annotations.gff3.gz` },
    'ncbi-annotations.gff3.gz.tbi': { path: annotation.index, sha256: annotationChecksums.index, kind: 'annotation', contentType: 'application/octet-stream', filename: `${accession}.ncbi-annotations.gff3.gz.tbi` },
  };
  const known = fixed[logicalAsset];
  if (known) {
    if (!known.path || (logicalAsset.startsWith('ncbi-') && normalizeAnnotationStatus(annotation.status) !== 'available')) return null;
    return { ...known, path: safeAssetPath(known.path, `${accession} asset`) };
  }
  const match = /^studies\/([^/]+)\/(raw\.bed|experimental-tss\.gff3\.gz(?:\.tbi)?)$/.exec(logicalAsset);
  if (!match || !STUDY_PATTERN.test(match[1])) return null;
  const catalogStudy = catalog.studies.find((study) => study.studyId === match[1] && study.gcf === accession);
  if (!catalogStudy) return null;
  const study = normalizeStudy(catalogStudy, genome);
  if (match[2] === 'raw.bed') return { path: study.assets.rawBed, sha256: study.sourceSha256 || study.checksums.rawBed, kind: 'raw-bed' as const, contentType: 'text/tab-separated-values; charset=utf-8', filename: `${study.studyId}.bed` };
  if (match[2].endsWith('.tbi')) return study.assets.index ? { path: study.assets.index, sha256: study.checksums.index, kind: 'experimental-tss' as const, contentType: 'application/octet-stream', filename: `${study.studyId}.experimental-tss.gff3.gz.tbi` } : null;
  return { path: study.assets.data, sha256: study.checksums.data, kind: 'experimental-tss' as const, contentType: 'application/gzip', filename: `${study.studyId}.experimental-tss.gff3.gz` };
}

export class JsonExperimentalTssRepository implements ExperimentalTssRepository {
  private readonly catalog: NormalizedCatalog;

  constructor(catalog: unknown) {
    this.catalog = parseCatalog(catalog);
  }

  async getActiveRelease() { return this.catalog.summary; }

  async search(query: { q?: string; year?: number | null } = {}): Promise<ExperimentalTssStudySearchResponse> {
    const genomes = new Map(this.catalog.genomes.map((genome) => [genome.accession, genome]));
    const studies = this.catalog.studies.map((study) => normalizeStudy(study, genomes.get(study.gcf) || {}));
    const items = searchStudies(studies, query).sort((left, right) => right.year - left.year || left.studyId.localeCompare(right.studyId));
    return { release: this.catalog.summary, items, total: items.length };
  }

  async listGenomes() {
    return this.catalog.genomes.map((genome) => buildGenome(this.catalog, genome));
  }

  async getGenome(accession: string) {
    if (!ACCESSION_PATTERN.test(accession)) return null;
    const genome = this.catalog.genomes.find((item) => item.accession === accession);
    return genome ? buildGenome(this.catalog, genome) : null;
  }

  async resolveAsset(accession: string, logicalAsset: string): Promise<ExperimentalResolvedAsset | null> {
    if (!ACCESSION_PATTERN.test(accession) || !logicalAsset || /[\\\u0000-\u001f\u007f]/.test(logicalAsset)) return null;
    const match = findCatalogAsset(this.catalog, accession, logicalAsset);
    if (!match) return null;
    return {
      upstreamUrl: upstreamUrl(configuredAssetBase(this.catalog.assetBase), match.path),
      filename: match.filename,
      contentType: match.contentType,
      sha256: match.sha256 && /^[0-9a-f]{64}$/.test(match.sha256) ? match.sha256 : null,
      kind: match.kind,
    };
  }
}

type D1Row = Record<string, string | number | null>;

async function activeD1Release(database: D1Database) {
  const row = await database.prepare(
    "SELECT r.* FROM experimental_portal_state p JOIN releases r ON r.release_id = p.active_release_id WHERE p.singleton = 1 AND r.release_kind = 'experimental_tss' AND COALESCE(r.publication_status, 'ready') = 'ready'",
  ).first<D1Row>();
  if (!row) throw new ExperimentalTssCatalogUnavailableError('No active experimental TSS release is published.');
  return row;
}

async function d1Catalog(database: D1Database): Promise<NormalizedCatalog> {
  const release = await activeD1Release(database);
  const releaseId = String(release.release_id);
  const [studyResult, genomeResult] = await database.batch<D1Row>([
    database.prepare([
      'SELECT fs.*, fd.configuration_json, g.organism_name',
      'FROM feature_sets fs',
      'JOIN feature_definitions fd ON fd.release_id = fs.release_id AND fd.definition_id = fs.definition_id',
      'JOIN genomes g ON g.release_id = fs.release_id AND g.accession = fs.accession',
      "WHERE fs.release_id = ? AND fs.feature_type = 'experimental_tss' AND fs.status = 'ready'",
      'ORDER BY fs.source_version DESC, fs.definition_id',
    ].join(' ')).bind(releaseId),
    database.prepare([
      'SELECT g.*, a.status AS annotation_status, a.data_path AS annotation_data_path, a.index_path AS annotation_index_path,',
      'a.data_sha256 AS annotation_data_sha256, a.index_sha256 AS annotation_index_sha256',
      'FROM genomes g LEFT JOIN feature_sets a ON a.release_id = g.release_id AND a.accession = g.accession',
      "AND a.feature_type = 'gene_annotation' AND a.is_default = 1",
      'WHERE g.release_id = ? ORDER BY g.accession',
    ].join(' ')).bind(releaseId),
  ]);
  const studyRows = studyResult.results || [];
  const studies = studyRows.map((row) => {
    const config = parseJsonObject(row.configuration_json);
    const provenance = parseJsonObject(row.provenance_json);
    return {
      studyId: String(row.definition_id), gcf: String(row.accession), pmid: config.pmid,
      year: config.year ?? row.source_version, recordCount: row.feature_count,
      publication: config.publication, organismName: row.organism_name,
      datasetRow: provenance.datasetRow ?? provenance.dataset_row,
      sourceFile: provenance.sourceFile ?? provenance.source_file,
      sourceSha256: provenance.sourceSha256 ?? provenance.source_sha256,
      duplicateGroupCount: provenance.duplicateGroupCount ?? provenance.duplicate_group_count,
      provenance,
      assets: { rawBed: provenance.rawBedPath ?? provenance.raw_bed_path, data: row.data_path, index: row.index_path },
      checksums: { rawBed: provenance.sourceSha256 ?? provenance.source_sha256, data: row.data_sha256, index: row.index_sha256 },
    } as CatalogStudy;
  });
  const studiesByGenome = new Map<string, string[]>();
  for (const study of studies) studiesByGenome.set(study.gcf, [...(studiesByGenome.get(study.gcf) || []), study.studyId]);
  const genomes = (genomeResult.results || []).map((row) => {
    const annotationStatus = normalizeAnnotationStatus(row.annotation_status);
    return {
      accession: String(row.accession), organismName: row.organism_name, strain: row.strain,
      assemblyName: row.assembly_name, genbankAssemblyAccession: row.genbank_assembly_accession,
      defaultLocus: row.default_locus, primarySequence: row.primary_sequence,
      genomeSizeBp: row.genome_size_bp, contigCount: row.contig_count,
      referenceStorage: parseJsonObject(row.reference_storage_json),
      annotation: { status: annotationStatus, data: row.annotation_data_path, index: row.annotation_index_path, checksums: { data: row.annotation_data_sha256, index: row.annotation_index_sha256 } },
      studies: studiesByGenome.get(String(row.accession)) || [],
    } as CatalogGenome;
  });
  const featureSummary = parseJsonObject(release.feature_summary_json);
  const uniquePmids = new Set(studies.map((study) => stringValue(study.pmid))).size;
  return parseCatalog({
    schemaVersion: 1, releaseId, releaseKind: 'experimental_tss', generatedAt: release.generated_at,
    description: release.description, assetBase: release.release_asset_base_url,
    summary: {
      studies: integerValue(featureSummary.studies) ?? studies.length,
      genomes: integerValue(featureSummary.genomes) ?? genomes.length,
      publications: integerValue(featureSummary.publications) ?? uniquePmids,
      observations: integerValue(featureSummary.observations) ?? studyRows.reduce((sum, row) => sum + (integerValue(row.feature_count) || 0), 0),
    }, studies, genomes,
  });
}

export class D1ExperimentalTssRepository implements ExperimentalTssRepository {
  constructor(private readonly database: D1Database) {}

  private async jsonRepository() { return new JsonExperimentalTssRepository(await d1Catalog(this.database)); }
  async getActiveRelease() { return (await this.jsonRepository()).getActiveRelease(); }
  async search(query?: { q?: string; year?: number | null }) { return (await this.jsonRepository()).search(query); }
  async listGenomes() { return (await this.jsonRepository()).listGenomes(); }
  async getGenome(accession: string) { return (await this.jsonRepository()).getGenome(accession); }
  async resolveAsset(accession: string, logicalAsset: string) { return (await this.jsonRepository()).resolveAsset(accession, logicalAsset); }
}

const emptyExperimentalTssRepository = new JsonExperimentalTssRepository({
  releaseKind: 'experimental_tss',
  releaseId: 'not-configured',
  description: 'No experimental TSS release is configured for this local environment.',
  studies: [],
  genomes: [],
});

let localRepository: JsonExperimentalTssRepository | null = null;
let localPath: string | null = null;

function configuredLocalRepository() {
  const configuredPath = stringValue(process.env.EXPERIMENTAL_TSS_CATALOG_PATH);
  if (!configuredPath) return null;
  const absolutePath = resolve(configuredPath);
  if (localRepository && localPath === absolutePath) return localRepository;
  try {
    localRepository = new JsonExperimentalTssRepository(JSON.parse(readFileSync(absolutePath, 'utf8')));
    localPath = absolutePath;
    return localRepository;
  } catch (cause) {
    if (cause instanceof ExperimentalTssCatalogUnavailableError) throw cause;
    throw new ExperimentalTssCatalogUnavailableError(`Experimental TSS catalog could not be read: ${cause instanceof Error ? cause.message : 'unknown error'}`);
  }
}

async function configuredD1() {
  if (process.env.EXPERIMENTAL_TSS_CATALOG_PATH) return null;
  const requested = process.env.RAPPTOR_CATALOG_BACKEND === 'd1' || process.env.NODE_ENV === 'production';
  if (!requested) return null;
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const database = getCloudflareContext().env.RAPPTOR_DB;
    if (!database) throw new ExperimentalTssCatalogUnavailableError('RAPPTOR_DB is not bound to this deployment.');
    return database;
  } catch (cause) {
    if (cause instanceof ExperimentalTssCatalogUnavailableError) throw cause;
    throw new ExperimentalTssCatalogUnavailableError('Cloudflare D1 experimental catalog context is unavailable.');
  }
}

export const experimentalTssRepository: ExperimentalTssRepository = {
  async getActiveRelease() {
    const local = configuredLocalRepository();
    if (local) return local.getActiveRelease();
    const database = await configuredD1();
    if (database) return new D1ExperimentalTssRepository(database).getActiveRelease();
    return emptyExperimentalTssRepository.getActiveRelease();
  },
  async search(query) {
    const local = configuredLocalRepository();
    if (local) return local.search(query);
    const database = await configuredD1();
    if (database) return new D1ExperimentalTssRepository(database).search(query);
    return emptyExperimentalTssRepository.search(query);
  },
  async listGenomes() {
    const local = configuredLocalRepository();
    if (local) return local.listGenomes();
    const database = await configuredD1();
    if (database) return new D1ExperimentalTssRepository(database).listGenomes();
    return emptyExperimentalTssRepository.listGenomes();
  },
  async getGenome(accession) {
    const local = configuredLocalRepository();
    if (local) return local.getGenome(accession);
    const database = await configuredD1();
    if (database) return new D1ExperimentalTssRepository(database).getGenome(accession);
    return null;
  },
  async resolveAsset(accession, logicalAsset) {
    const local = configuredLocalRepository();
    if (local) return local.resolveAsset(accession, logicalAsset);
    const database = await configuredD1();
    if (database) return new D1ExperimentalTssRepository(database).resolveAsset(accession, logicalAsset);
    return null;
  },
};
