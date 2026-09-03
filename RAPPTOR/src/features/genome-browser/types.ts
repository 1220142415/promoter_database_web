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

/**
 * Browser-local tracks used by the prediction prototype. These assets are
 * intentionally separate from release assets: they can be blob URLs and do
 * not imply that a prediction was produced by the live service.
 */
export interface JBrowsePrototypeTracks {
  rawScoresBedGraphPlus: string;
  rawScoresBedGraphMinus: string | null;
  calledPeaksGff3: string;
  rawScoresLabel?: string;
  calledPeaksLabel?: string;
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
    reference?: string;
    scores?: string;
    promoters?: string;
    experimentalTss?: string;
    annotation?: string;
  };
  /**
   * Local, illustrative tracks for the browser-only prediction prototype.
   * They are not part of the release asset contract.
   */
  prototypeTracks?: JBrowsePrototypeTracks | null;
  /**
   * Prototype assemblies can contain browser-local input. Do not place their
   * contig names or view state in a share URL.
   */
  allowShareView?: boolean;
}
