// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PredictionBrowser from '@/features/prediction/components/prediction-browser';

vi.mock('@/features/genome-browser/components/unified-browser-panel', () => ({
  default: ({ prediction, shareFragment }: { prediction: {
    assemblyName: string;
    assemblyAbout?: { label: string; name: string };
    defaultLocus: string;
    assets: Record<string, string | null>;
    predictionProcessing?: { sigma: number; distance: number; cutoff: number; positionBase: number };
    smoothScoreTrack?: boolean;
    precomputedScoreSigma?: number;
    predictionSequenceLengths?: Record<string, number>;
    trackLabels?: { annotation?: string };
  }; shareFragment?: string }) => <div
    data-testid="mock-unified-browser"
    data-assembly={prediction.assemblyName}
    data-contig-name={prediction.assemblyAbout?.name}
    data-about-label={prediction.assemblyAbout?.label}
    data-locus={prediction.defaultLocus}
    data-fasta={prediction.assets.fasta}
    data-fai={prediction.assets.fastaFai}
    data-scores-plus={prediction.assets.promoterScoresPlus}
    data-scores-minus={prediction.assets.promoterScoresMinus}
    data-peaks={prediction.assets.predictedPromoters}
    data-peaks-index={prediction.assets.predictedPromotersIndex}
    data-processing={JSON.stringify(prediction.predictionProcessing)}
    data-smoothing={prediction.smoothScoreTrack ? 'on' : 'off'}
    data-precomputed-sigma={prediction.precomputedScoreSigma ?? ''}
    data-sequence-lengths={JSON.stringify(prediction.predictionSequenceLengths || {})}
    data-annotation={prediction.assets.ncbiAnnotations || ''}
    data-annotation-label={prediction.trackLabels?.annotation || ''}
    data-share-fragment={shareFragment || ''}
  />,
}));

afterEach(() => vi.unstubAllGlobals());

describe('prediction browser tracks', () => {
  const browserFiles = ['input.fasta', 'input.fasta.fai', 'scores.plus.bw'].map(filename => ({ filename }));

  it('uses pre-smoothed BigWigs without a notice or double smoothing and preserves legacy display', () => {
    const { rerender } = render(<PredictionBrowser jobId="a" refName="chr1" accessToken="shared_access_token_1234567890abcdef" artifacts={browserFiles} summary={{ stride: 1 }} />);
    const browser = screen.getByTestId('mock-unified-browser');
    expect(browser).toHaveAttribute('data-smoothing', 'on');
    expect(browser).toHaveAttribute('data-scores-plus', '/api/predictions/jobs/a/artifacts/scores.plus.bw');
    expect(screen.queryByText(/Gaussian-smoothed/)).not.toBeInTheDocument();
    rerender(<PredictionBrowser jobId="a" refName="chr1" accessToken="shared_access_token_1234567890abcdef" artifacts={browserFiles} summary={{ stride: 1, bigwig_smoothing: { method: 'gaussian', sigma: 1, mode: 'reflect' } }} />);
    expect(browser).toHaveAttribute('data-smoothing', 'off');
    expect(browser).toHaveAttribute('data-precomputed-sigma', '1');
    for (const summary of [{ stride: 20 }, {}]) {
      rerender(<PredictionBrowser jobId="a" refName="chr1" accessToken="shared_access_token_1234567890abcdef" artifacts={browserFiles} summary={summary} />);
      expect(browser).toHaveAttribute('data-smoothing', 'off');
      expect(browser).toHaveAttribute('data-precomputed-sigma', '');
    }
  });

  it('reports missing promoter output for sparse scans from legacy services', () => {
    render(<PredictionBrowser jobId="a" refName="chr1" accessToken="shared_access_token_1234567890abcdef" artifacts={browserFiles} summary={{ stride: 20 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Promoter predictions were not generated');
    expect(screen.getByTestId('mock-unified-browser')).toHaveAttribute('data-peaks', '');
  });

  it('distinguishes missing promoter output from a completed zero-promoter result', () => {
    const { rerender } = render(<PredictionBrowser jobId="a" refName="chr1" accessToken="shared_access_token_1234567890abcdef" artifacts={browserFiles} summary={{ stride: 1 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Promoter predictions were not generated');
    rerender(<PredictionBrowser jobId="a" refName="chr1" accessToken="shared_access_token_1234567890abcdef" artifacts={[...browserFiles, { filename: 'peaks.gff3' }]} summary={{ stride: 1, peak_count: 0 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('No promoter predictions passed the selected cutoff');
    expect(document.body).not.toHaveTextContent(/peak/i);
    expect(screen.getByTestId('mock-unified-browser')).toHaveAttribute('data-peaks', '/api/predictions/jobs/a/artifacts/peaks.gff3');
  });

  it('does not invent a stride for legacy results or show missing-output copy when promoters exist', () => {
    const { rerender } = render(<PredictionBrowser jobId="a" refName="chr1" accessToken="shared_access_token_1234567890abcdef" artifacts={browserFiles} summary={{}} />);
    expect(screen.getByRole('status')).toHaveTextContent('Promoter predictions were not generated');
    expect(screen.getByRole('status')).not.toHaveTextContent('20 bp');
    rerender(<PredictionBrowser jobId="a" refName="chr1" accessToken="shared_access_token_1234567890abcdef" artifacts={[...browserFiles, { filename: 'peaks.gff3' }]} summary={{ peak_count: 3 }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('adds the unindexed promoter track only when returned, with service metadata', () => {
    const artifacts = ['input.fasta', 'input.fasta.fai', 'scores.plus.bw', 'peaks.gff3'].map(filename => ({ filename }));
    const { rerender } = render(<PredictionBrowser jobId="a" refName="chr1" accessToken="shared_access_token_1234567890abcdef" artifacts={artifacts} summary={{ smoothing: { method: 'gaussian', sigma: 1, mode: 'reflect' }, peak_calling: { distance: 10, cutoff: .9, operator: '>' } }} />);
    const browser = screen.getByTestId('mock-unified-browser');
    expect(browser).toHaveAttribute('data-peaks', '/api/predictions/jobs/a/artifacts/peaks.gff3');
    expect(browser).toHaveAttribute('data-peaks-index', '');
    expect(browser).toHaveAttribute('data-processing', JSON.stringify({ sigma: 1, distance: 10, cutoff: .9, positionBase: 1 }));
    rerender(<PredictionBrowser jobId="a" refName="chr1" accessToken="shared_access_token_1234567890abcdef" artifacts={artifacts.slice(0, -1)} />);
    expect(browser).toHaveAttribute('data-peaks', '');
  });
  beforeEach(() => {
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:annotation') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
  });

  it('maps prediction artifacts and a browser-local GFF3 into the unified browser', async () => {
    const user = userEvent.setup();
    render(<PredictionBrowser jobId="job-1" refName="chr1" accessToken="shared_access_token_1234567890abcdef" />);

    const browser = screen.getByTestId('mock-unified-browser');
    expect(browser).toHaveAttribute('data-assembly', 'prediction-job-1');
    expect(browser).toHaveAttribute('data-contig-name', 'chr1');
    expect(browser).toHaveAttribute('data-about-label', 'Contig');
    expect(browser).toHaveAttribute('data-locus', 'chr1:1-10000');
    expect(browser).toHaveAttribute('data-fasta', '/api/predictions/jobs/job-1/artifacts/input.fasta');
    expect(browser).toHaveAttribute('data-fai', '/api/predictions/jobs/job-1/artifacts/input.fasta.fai');
    expect(browser).toHaveAttribute('data-scores-plus', '/api/predictions/jobs/job-1/artifacts/scores.plus.bw');
    expect(browser).toHaveAttribute('data-scores-minus', '/api/predictions/jobs/job-1/artifacts/scores.minus.bw');
    expect(browser).toHaveAttribute('data-share-fragment', 'access=shared_access_token_1234567890abcdef&ref=chr1&mode=genome_scan');

    await user.upload(screen.getByLabelText('Add GFF3 annotation'), new File([
      '##gff-version 3\nchr1\ttest\tgene\t10\t40\t.\t+\t.\tID=gene1\n',
    ], 'genes.gff3', { type: 'text/plain' }));

    expect(browser).toHaveAttribute('data-annotation', 'blob:annotation');
    expect(browser).toHaveAttribute('data-annotation-label', 'Uploaded annotation · genes.gff3');
    expect(screen.getByText('genes.gff3')).toBeInTheDocument();
  });

  it('uses the contig identifier for display while retaining the task-specific assembly key', () => {
    render(<PredictionBrowser jobId="job-1" refName="NC_000913.3" accessToken="shared_access_token_1234567890abcdef" />);
    const browser = screen.getByTestId('mock-unified-browser');
    expect(browser).toHaveAttribute('data-contig-name', 'NC_000913.3');
    expect(browser).toHaveAttribute('data-assembly', 'prediction-job-1');
  });

  it('loads exact contig lengths from the completed task FAI for legacy peak boundaries', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/predictions/jobs/legacy/artifacts/input.fasta.fai');
      return new Response('chr1\t100\t6\t80\t81\nplasmid\t42\t113\t42\t43\n');
    }));
    render(<PredictionBrowser
      jobId="legacy" refName="chr1" accessToken="shared_access_token_1234567890abcdef"
      artifacts={[...browserFiles, { filename: 'peaks.gff3' }]}
      summary={{ stride: 2, peak_count: 1 }}
    />);
    await waitFor(() => expect(screen.getByTestId('mock-unified-browser')).toHaveAttribute(
      'data-sequence-lengths', JSON.stringify({ chr1: 100, plasmid: 42 }),
    ));
  });
});
