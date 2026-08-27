export type ExperimentalAnnotationStatus = 'available' | 'missing' | 'incompatible';

export interface ExperimentalPublication {
  title: string | null;
  authors: string[];
  journal: string | null;
  doi: string | null;
  status: 'resolved' | 'unresolved' | 'unavailable';
}

export interface ExperimentalTssStudy {
  studyId: string;
  datasetRow: number | null;
  accession: string;
  organismName: string;
  pmid: string;
  year: number;
  recordCount: number;
  sourceFile: string | null;
  sourceSha256: string | null;
  duplicateGroupCount: number | null;
  publication: ExperimentalPublication;
  assets: {
    rawBed: string;
    data: string;
    index: string | null;
  };
  checksums: Record<string, string>;
}

export interface ExperimentalTssReleaseSummary {
  releaseId: string;
  generatedAt: string | null;
  description: string | null;
  studies: number;
  genomes: number;
  publications: number;
  observations: number;
  years: number[];
}

export interface ExperimentalTssStudySearchResponse {
  release: ExperimentalTssReleaseSummary;
  items: ExperimentalTssStudy[];
  total: number;
}

export interface ExperimentalTssGenome {
  releaseId: string;
  accession: string;
  organismName: string;
  strain: string | null;
  assemblyName: string | null;
  genbankAssemblyAccession: string | null;
  defaultLocus: string;
  primarySequence: string | null;
  genomeSizeBp: number | null;
  contigCount: number | null;
  annotationStatus: ExperimentalAnnotationStatus;
  referenceAccession?: string | null;
  referenceSha256?: string | null;
  assetBase: string;
  assets: {
    fasta: string;
    fastaFai: string | null;
    fastaGzi: string | null;
    ncbiAnnotations: string | null;
    ncbiAnnotationsIndex: string | null;
  };
  studies: ExperimentalTssStudy[];
}

export type ExperimentalAssetKind = 'reference' | 'annotation' | 'experimental-tss' | 'raw-bed';

export type ExperimentalAssetTransform =
  | { kind: 'gunzip'; refName: string | null }
  | {
      kind: 'experimental-bed-to-gff3';
      accession: string;
      studyId: string;
      pmid: string;
      year: number;
      sourceFile: string | null;
    };

export interface ExperimentalResolvedAsset {
  upstreamUrl: string;
  filename: string;
  contentType: string;
  sha256: string | null;
  kind: ExperimentalAssetKind;
  transform: ExperimentalAssetTransform | null;
}

export interface ExperimentalTssRepository {
  getActiveRelease(): Promise<ExperimentalTssReleaseSummary>;
  search(query?: { q?: string; year?: number | null }): Promise<ExperimentalTssStudySearchResponse>;
  listGenomes(): Promise<ExperimentalTssGenome[]>;
  getGenome(accession: string): Promise<ExperimentalTssGenome | null>;
  resolveAsset(accession: string, logicalAsset: string): Promise<ExperimentalResolvedAsset | null>;
}
