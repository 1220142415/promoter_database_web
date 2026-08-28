export interface JBrowseAssemblyAssets {
  fasta: string;
  fastaFai: string;
  fastaGzi: string;
  predictedPromoters: string;
  predictedPromotersIndex: string;
  promoterScoresPlus: string | null;
  promoterScoresMinus: string | null;
  ncbiAnnotations: string | null;
  ncbiAnnotationsIndex: string | null;
  metadata?: string | null;
  experimentalTss?: string | null;
  experimentalTssIndex?: string | null;
}

export interface JBrowseAssemblyConfig {
  assemblyName: string;
  defaultLocus: string;
  assetBase: string;
  assets: JBrowseAssemblyAssets;
  regionExportBase?: string;
  adapterMode?: 'indexed' | 'unindexed';
  annotationTrackKind?: 'ncbi' | 'annotation';
  trackLabels?: {
    scores?: string;
    promoters?: string;
    experimentalTss?: string;
    annotation?: string;
  };
}
