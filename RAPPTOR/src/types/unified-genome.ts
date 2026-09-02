import type {
  GenomeAnnotationFilter,
  GenomeCatalogMatch,
  GenomeCatalogRow,
  GenomeSortDirection,
  GenomeSortField,
  GenomeTaxonomyFacets,
  GenomeTaxonomyFilters,
} from '@/features/genomes/types';
import type { ExperimentalTssGenome } from '@/types/experimental-tss';

export type UnifiedGenomeEvidenceState = 'prediction_only' | 'experimental_only' | 'both';
export type UnifiedGenomeEvidenceFilter = 'all' | 'predictions' | 'experimental' | 'both';

export interface UnifiedGenomeAlias {
  canonicalAccession: string;
  predictionAccession: string;
  experimentalAccession: string;
  relation: 'exact' | 'ncbi_reciprocal';
}

export interface UnifiedGenomeReleases {
  predictionReleaseId: string;
  experimentalReleaseId: string | null;
  compositeRevision: string;
}

export interface UnifiedGenomeRow extends GenomeCatalogRow {
  assemblyKey?: string;
  assemblySource?: 'unified' | 'prediction' | 'experimental';
  canonicalAccession: string;
  aliases: string[];
  predictionAccession: string | null;
  predictionAvailable: boolean;
  experimentalAccession: string | null;
  evidenceState: UnifiedGenomeEvidenceState;
  experimentalObservationCount: number;
  experimentalStudyCount: number;
  assemblyCompatibility?: 'exact' | 'reciprocal_alias' | 'single_source' | 'mismatch';
  overlayAllowed?: boolean;
}

export interface UnifiedGenomeSearchQuery {
  q: string;
  taxonomy: GenomeTaxonomyFilters;
  source: string;
  annotation: GenomeAnnotationFilter;
  evidence: UnifiedGenomeEvidenceFilter;
  sort: GenomeSortField;
  direction: GenomeSortDirection;
  limit: 25 | 50 | 100;
  cursor: string | null;
}

export interface UnifiedGenomeStats {
  totalGenomes: number;
  predictionGenomes: number;
  experimentalGenomes: number;
  bothGenomes: number;
  totalPredictedPromoters: number;
  totalExperimentalObservations: number;
  totalExperimentalStudies: number;
  totalExperimentalPublications: number;
}

export interface UnifiedGenomeSearchResponse {
  releases: UnifiedGenomeReleases;
  items: UnifiedGenomeRow[];
  total: number;
  facets: {
    sources: string[];
    taxonomy: GenomeTaxonomyFacets;
    evidence: Record<UnifiedGenomeEvidenceState, number>;
  };
  stats: UnifiedGenomeStats;
  pageInfo: {
    nextCursor: string | null;
    hasNext: boolean;
  };
}

export interface UnifiedGenomeMatch {
  canonicalAccession: string;
  aliases: string[];
  evidenceState: UnifiedGenomeEvidenceState;
  assemblyCompatibility: 'exact' | 'reciprocal_alias' | 'single_source' | 'mismatch';
  overlayAllowed?: boolean;
  availableAssemblySources?: Array<'prediction' | 'experimental'>;
  predictionAvailable: boolean;
  prediction: GenomeCatalogMatch | null;
  experimental: ExperimentalTssGenome | null;
  releases: UnifiedGenomeReleases;
}

export interface UnifiedGenomeRepository {
  search(query: UnifiedGenomeSearchQuery): Promise<UnifiedGenomeSearchResponse>;
  getByAccession(accession: string, assemblySource?: 'prediction' | 'experimental'): Promise<UnifiedGenomeMatch | null>;
  getStats(): Promise<{ releases: UnifiedGenomeReleases; stats: UnifiedGenomeStats }>;
  resolveCanonicalAccession(accession: string): string | null;
}
