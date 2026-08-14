import type { GenomeStorageMap, ReleaseGenome } from '@/types/release';

export type GenomeSortField = 'accession' | 'organism' | 'genome-size' | 'promoters';
export type GenomeSortDirection = 'asc' | 'desc';
export type GenomeAnnotationFilter = '' | 'available' | 'unavailable';
export type GenomeTaxonomyRank = 'domain' | 'phylum' | 'class' | 'order' | 'family' | 'genus';

export type GenomeTaxonomyFilters = Record<GenomeTaxonomyRank, string>;
export type GenomeTaxonomyFacets = Record<GenomeTaxonomyRank, string[]>;

export interface GenomeCatalogRow {
  accession: string;
  organismName: string;
  strain: string | null;
  domain: string | null;
  phylum: string | null;
  className: string | null;
  orderName: string | null;
  family: string | null;
  genus: string | null;
  genomeSource: string | null;
  genomeSizeBp: number | null;
  contigCount: number | null;
  predictedPromoterCount: number;
  annotationStatus: ReleaseGenome['annotationStatus'];
}

export interface GenomeSearchQuery {
  q: string;
  taxonomy: GenomeTaxonomyFilters;
  source: string;
  annotation: GenomeAnnotationFilter;
  sort: GenomeSortField;
  direction: GenomeSortDirection;
  limit: 25 | 50 | 100;
  cursor: string | null;
}

export interface GenomeSearchResponse {
  releaseId: string;
  items: GenomeCatalogRow[];
  total: number;
  facets: {
    sources: string[];
    taxonomy: GenomeTaxonomyFacets;
  };
  pageInfo: {
    nextCursor: string | null;
    hasNext: boolean;
  };
}

export interface GenomeCatalogMatch {
  releaseId: string;
  assetBase: string | null;
  genome: ReleaseGenome;
  storage: GenomeStorageMap | null;
  resourceStatus?: 'ready' | 'staged';
}
