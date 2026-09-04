import type { ReleaseAssets } from '@/types/release';

export type CyanobacteriaGenomeId = 'ASM970v1' | 'Cf6912' | 'CP003597.1';

export interface CyanobacteriaPredictionWindow {
  lengthBp: number;
  upstreamBp: number;
  downstreamBp: number;
  anchorAttribute: string;
}

export interface CyanobacteriaAnnotationSummary {
  source: 'NCBI' | 'Prodigal';
  label: string;
  description: string;
  featureCounts: Record<string, number>;
  limitations: string | null;
}

export interface CyanobacteriaExperimentalEvidence {
  status: 'experimentally_supported';
  label: string;
  studyId: string;
  pmid: string;
  year: number;
  title: string;
  journal: string;
  doi: string;
  assemblyAccession: string;
  observationCount: number;
  uniqueTssCount: number;
  crossStudySupportedTssCount: number;
  methodBoundary: string;
  hfPath: string;
}

export interface CyanobacteriaGenome {
  id: CyanobacteriaGenomeId;
  identifierType: 'assembly name' | 'dataset identifier' | 'sequence accession';
  organismName: string;
  strain: string;
  genomeSizeBp: number;
  gcContent: number;
  contigCount: number;
  primarySequence: string;
  defaultLocus: string;
  candidatePeakCount: number;
  candidatePeakStrands: { plus: number; minus: number };
  predictedPromoterCount: number;
  predictedPromoterStrands: { plus: number; minus: number };
  annotation: CyanobacteriaAnnotationSummary;
  experimentalEvidence: CyanobacteriaExperimentalEvidence | null;
  assets: ReleaseAssets & {
    experimentalTss?: string | null;
    experimentalTssIndex?: string | null;
    candidateSource: string;
    predictionSource: string;
    annotationSource: string;
    experimentalTssSource: string | null;
  };
}

export interface CyanobacteriaRelease {
  releaseId: string;
  generatedAt: string;
  title: string;
  description: string;
  assetBaseUrl: string;
  manifest: string;
  checksums: string;
  releaseMetadata: string;
  totalGenomes: number;
  totalCandidatePeaks: number;
  totalPredictedPromoters: number;
  totalExperimentallySupportedGenomes: number;
  totalExperimentalTssObservations: number;
  predictionWindow: CyanobacteriaPredictionWindow;
  genomes: CyanobacteriaGenome[];
}
