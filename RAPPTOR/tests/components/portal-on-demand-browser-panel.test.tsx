// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PortalOnDemandBrowserPanel from '@/features/genome-browser/components/portal-on-demand-browser-panel';
import {
  firstFastaRefName,
  loadCachedGenomeAsset,
  maybeDecompressGzip,
  readCachedGenomeAsset,
  shouldDownloadWholeAsset,
} from '@/features/genome-browser/on-demand-genome-assets';
import type { ExperimentalTssGenome } from '@/types/experimental-tss';

vi.mock('@/features/genome-browser/components/unified-browser-panel', () => ({
  default: ({ prediction, experimental }: { prediction: { assemblyName: string; defaultLocus: string; assets: { promoterScoresPlus: string | null; promoterScoresMinus: string | null; ncbiAnnotations: string | null } }; experimental?: ExperimentalTssGenome }) => (
    <div
      data-testid={experimental ? 'prepared-unified-browser' : 'prepared-browser'}
      data-prediction={prediction.assemblyName}
      data-experimental={experimental?.accession || ''}
      data-locus={prediction.defaultLocus}
      data-scores={String(Boolean(prediction.assets.promoterScoresPlus && prediction.assets.promoterScoresMinus))}
      data-score-plus={prediction.assets.promoterScoresPlus || ''}
      data-score-minus={prediction.assets.promoterScoresMinus || ''}
      data-ncbi={String(Boolean(prediction.assets.ncbiAnnotations))}
    />
  ),
}));

vi.mock('@/features/genome-browser/on-demand-genome-assets', () => ({
  MAX_FULL_SCORE_DOWNLOAD_BYTES: 8 * 1024 * 1024,
  firstFastaRefName: vi.fn(() => 'NC_000001.1'),
  loadCachedGenomeAsset: vi.fn(),
  readCachedGenomeAsset: vi.fn(() => Promise.resolve(null)),
  maybeDecompressGzip: vi.fn((blob: Blob) => Promise.resolve(blob)),
  shouldDownloadWholeAsset: vi.fn(() => Promise.resolve(true)),
}));

const plannedAssets = {
  reference: 'https://huggingface.co/reference.fna.gz',
  predictedPromoters: 'https://huggingface.co/promoters.gff3',
  promoterScoresPlus: 'https://huggingface.co/promoter-scores.plus.bw',
  promoterScoresMinus: 'https://huggingface.co/promoter-scores.minus.bw',
  ncbiAnnotations: 'https://huggingface.co/annotation.gff3.gz',
  cacheVersions: {
    reference: 'a'.repeat(64),
    predictedPromoters: 'b'.repeat(64),
    promoterScoresPlus: 'd'.repeat(64),
    promoterScoresMinus: 'e'.repeat(64),
    ncbiAnnotations: 'c'.repeat(64),
  },
  batch: '000',
};

describe('on-demand genome browser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldDownloadWholeAsset).mockResolvedValue(true);
    class MockUrl extends URL {
      static createObjectURL = vi.fn()
        .mockReturnValueOnce('blob:reference')
        .mockReturnValueOnce('blob:promoters')
        .mockReturnValueOnce('blob:annotation')
        .mockReturnValueOnce('blob:scores-plus')
        .mockReturnValueOnce('blob:scores-minus');

      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', MockUrl);
    const reference = {
      slice: () => ({ text: () => Promise.resolve('>NC_000001.1 reference\nACGT\n') }),
    } as unknown as Blob;
    vi.mocked(loadCachedGenomeAsset)
      .mockResolvedValueOnce(new Blob(['reference']))
      .mockResolvedValueOnce(new Blob(['promoters']))
      .mockResolvedValueOnce(new Blob(['annotation']))
      .mockResolvedValueOnce(new Blob(['scores-plus']))
      .mockResolvedValueOnce(new Blob(['scores-minus']));
    vi.mocked(maybeDecompressGzip)
      .mockResolvedValueOnce(reference)
      .mockResolvedValueOnce(new Blob(['promoters']))
      .mockResolvedValueOnce(new Blob(['annotation']));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('automatically prepares only the selected genome from release storage', async () => {
    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_000007325.1"
        releaseId="RAPPTOR 2026-08-13"
        plannedAssets={plannedAssets}
      />,
    );

    expect(await screen.findByTestId('prepared-browser')).toHaveAttribute('data-locus', 'NC_000001.1:1-10000');
    expect(screen.getByTestId('prepared-browser')).toHaveAttribute('data-scores', 'true');
    expect(screen.getByTestId('prepared-browser')).toHaveAttribute('data-score-plus', 'blob:scores-plus');
    expect(screen.getByTestId('prepared-browser')).toHaveAttribute('data-score-minus', 'blob:scores-minus');
    expect(screen.getByTestId('prepared-browser')).toHaveAttribute('data-ncbi', 'true');
    await vi.waitFor(() => expect(screen.getByLabelText('Genome files')).toHaveTextContent('ReferenceAvailablePromotersAvailableScoresAvailableAnnotationAvailable'));
    await vi.waitFor(() => expect(loadCachedGenomeAsset).toHaveBeenCalledTimes(5));
    expect(vi.mocked(loadCachedGenomeAsset).mock.calls.map(([url, key]) => [url, key])).toEqual([
      [plannedAssets.reference, `RAPPTOR 2026-08-13/GCA_000007325.1/reference/${'a'.repeat(64)}`],
      [plannedAssets.predictedPromoters, `RAPPTOR 2026-08-13/GCA_000007325.1/promoters/${'b'.repeat(64)}`],
      [plannedAssets.ncbiAnnotations, `RAPPTOR 2026-08-13/GCA_000007325.1/ncbi/${'c'.repeat(64)}`],
      [plannedAssets.promoterScoresPlus, `RAPPTOR 2026-08-13/GCA_000007325.1/scores-plus/${'d'.repeat(64)}`],
      [plannedAssets.promoterScoresMinus, `RAPPTOR 2026-08-13/GCA_000007325.1/scores-minus/${'e'.repeat(64)}`],
    ]);
    expect(maybeDecompressGzip).toHaveBeenCalledTimes(3);
    expect(firstFastaRefName).toHaveBeenCalled();
  });

  it('keeps legacy releases working without direct score URLs', async () => {
    const withoutScores = {
      ...plannedAssets,
      promoterScoresPlus: null,
      promoterScoresMinus: null,
      cacheVersions: {
        ...plannedAssets.cacheVersions,
        promoterScoresPlus: null,
        promoterScoresMinus: null,
      },
    };

    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_000007325.1"
        releaseId="RAPPTOR 2026-08-13"
        plannedAssets={withoutScores}
      />,
    );

    expect(await screen.findByTestId('prepared-browser')).toHaveAttribute('data-scores', 'false');
    expect(loadCachedGenomeAsset).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText('Genome files')).toHaveTextContent('ScoresNot available');
  });

  it('lets JBrowse range-read score files larger than the download limit', async () => {
    vi.mocked(shouldDownloadWholeAsset).mockResolvedValue(false);

    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_000007325.1"
        releaseId="RAPPTOR 2026-08-13"
        plannedAssets={plannedAssets}
      />,
    );

    expect(await screen.findByTestId('prepared-browser')).toHaveAttribute('data-score-plus', plannedAssets.promoterScoresPlus);
    expect(screen.getByTestId('prepared-browser')).toHaveAttribute('data-score-minus', plannedAssets.promoterScoresMinus);
    expect(loadCachedGenomeAsset).toHaveBeenCalledTimes(3);
    expect(shouldDownloadWholeAsset).toHaveBeenCalledTimes(2);
  });

  it('waits for small score files before mounting the browser', async () => {
    let resolveSize!: (small: boolean) => void;
    const sizeCheck = new Promise<boolean>((resolve) => { resolveSize = resolve; });
    vi.mocked(shouldDownloadWholeAsset).mockReturnValue(sizeCheck);

    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_000007325.1"
        releaseId="RAPPTOR 2026-08-13"
        plannedAssets={plannedAssets}
      />,
    );

    expect(screen.queryByTestId('prepared-browser')).not.toBeInTheDocument();
    resolveSize(false);
    expect(await screen.findByTestId('prepared-browser')).toHaveAttribute('data-score-plus', plannedAssets.promoterScoresPlus);
    expect(loadCachedGenomeAsset).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(screen.getByLabelText('Genome files')).toHaveTextContent('ScoresAvailable'));
  });

  it('uses complete score files from Cache Storage before checking the network', async () => {
    vi.mocked(readCachedGenomeAsset)
      .mockResolvedValueOnce(new Blob(['cached-plus']))
      .mockResolvedValueOnce(new Blob(['cached-minus']));

    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_000007325.1"
        releaseId="RAPPTOR 2026-08-13"
        plannedAssets={plannedAssets}
      />,
    );

    expect(await screen.findByTestId('prepared-browser')).toHaveAttribute('data-score-plus', 'blob:scores-plus');
    expect(screen.getByTestId('prepared-browser')).toHaveAttribute('data-score-minus', 'blob:scores-minus');
    expect(shouldDownloadWholeAsset).not.toHaveBeenCalled();
    expect(loadCachedGenomeAsset).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText('Genome files')).toHaveTextContent('ScoresAvailable');
  });

  it('combines staged predictions and annotation with experimental TSS', async () => {
    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_000007325.1"
        releaseId="RAPPTOR 2026-08-13"
        plannedAssets={plannedAssets}
        experimental={{ accession: 'GCF_000007325.1' } as ExperimentalTssGenome}
      />,
    );

    expect(await screen.findByTestId('prepared-unified-browser')).toHaveAttribute('data-prediction', 'GCA_000007325.1');
    expect(screen.getByTestId('prepared-unified-browser')).toHaveAttribute('data-experimental', 'GCF_000007325.1');
    expect(screen.getByTestId('prepared-unified-browser')).toHaveAttribute('data-ncbi', 'true');
  });

  it('prefers the fine promoter file stored with an experimental genome', async () => {
    const experimental = {
      releaseId: 'experimental-1',
      accession: 'GCF_000007325.1',
      assetBase: '/api/experimental-data/GCF_000007325.1',
      assets: { predictedPromoters: 'predicted-promoters.gff3' },
    } as ExperimentalTssGenome;
    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_000007325.1"
        releaseId="RAPPTOR 2026-08-13"
        plannedAssets={plannedAssets}
        experimental={experimental}
      />,
    );

    expect(await screen.findByTestId('prepared-unified-browser')).toBeInTheDocument();
    expect(vi.mocked(loadCachedGenomeAsset).mock.calls[1].slice(0, 2)).toEqual([
      '/api/experimental-data/GCF_000007325.1/predicted-promoters.gff3',
      'experimental-1/GCF_000007325.1/promoters/predicted-promoters.gff3',
    ]);
  });

  it('marks an intentionally absent annotation without requesting it', async () => {
    const withoutAnnotation = {
      ...plannedAssets,
      ncbiAnnotations: null,
      cacheVersions: { ...plannedAssets.cacheVersions, ncbiAnnotations: null },
    };
    vi.mocked(loadCachedGenomeAsset).mockReset()
      .mockResolvedValueOnce(new Blob(['reference']))
      .mockResolvedValueOnce(new Blob(['promoters']))
      .mockResolvedValueOnce(new Blob(['scores-plus']))
      .mockResolvedValueOnce(new Blob(['scores-minus']));

    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_002319795.1"
        releaseId="RAPPTOR 2026-08-13"
        plannedAssets={withoutAnnotation}
      />,
    );

    expect(await screen.findByTestId('prepared-browser')).toHaveAttribute('data-ncbi', 'false');
    expect(screen.getByLabelText('Genome files')).toHaveTextContent('ReferenceAvailablePromotersAvailableScoresAvailableAnnotationNot available');
    expect(loadCachedGenomeAsset).toHaveBeenCalledTimes(4);
  });

  it('marks only an inaccessible required file as failed', async () => {
    const withoutAnnotation = {
      ...plannedAssets,
      promoterScoresPlus: null,
      promoterScoresMinus: null,
      ncbiAnnotations: null,
      cacheVersions: {
        ...plannedAssets.cacheVersions,
        promoterScoresPlus: null,
        promoterScoresMinus: null,
        ncbiAnnotations: null,
      },
    };
    vi.mocked(loadCachedGenomeAsset).mockReset()
      .mockResolvedValueOnce(new Blob(['reference']))
      .mockRejectedValueOnce(new Error('Genome asset is unavailable (HTTP 404).'));

    render(
      <PortalOnDemandBrowserPanel
        accession="GCA_002319795.1"
        releaseId="RAPPTOR 2026-08-13"
        plannedAssets={withoutAnnotation}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Genome asset is unavailable (HTTP 404).');
    expect(screen.getByLabelText('Genome files')).toHaveTextContent('ReferenceAvailablePromotersFailedScoresNot availableAnnotationNot available');
    expect(screen.queryByTestId('prepared-browser')).not.toBeInTheDocument();
  });
});
