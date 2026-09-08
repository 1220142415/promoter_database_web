// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PredictionBrowser from '@/features/prediction/components/prediction-browser';

vi.mock('@/features/genome-browser/components/unified-browser-panel', () => ({
  default: ({ prediction }: { prediction: {
    assemblyName: string;
    assemblyAbout?: { label: string; name: string };
    defaultLocus: string;
    assets: Record<string, string | null>;
    predictionProcessing?: { sigma: number; distance: number; cutoff: number; positionBase: number };
    smoothScoreTrack?: boolean;
    trackLabels?: { annotation?: string };
  } }) => <div
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
    data-annotation={prediction.assets.ncbiAnnotations || ''}
    data-annotation-label={prediction.trackLabels?.annotation || ''}
  />,
}));

describe('prediction browser tracks', () => {
  const browserFiles = ['input.fasta', 'input.fasta.fai', 'scores.plus.bw'].map(filename => ({ filename }));

  it('smooths recorded stride-1 tasks without changing raw download assets or smoothing legacy/sparse runs', () => {
    const { rerender } = render(<PredictionBrowser jobId="a" refName="chr1" artifacts={browserFiles} summary={{ stride: 1 }} />);
    const browser = screen.getByTestId('mock-unified-browser');
    expect(browser).toHaveAttribute('data-smoothing', 'on');
    expect(browser).toHaveAttribute('data-scores-plus', '/api/predictions/jobs/a/artifacts/scores.plus.bw');
    expect(screen.getByText(/Gaussian-smoothed/)).toHaveTextContent('BigWig downloads retain the raw scores');
    for (const summary of [{ stride: 20 }, {}]) {
      rerender(<PredictionBrowser jobId="a" refName="chr1" artifacts={browserFiles} summary={summary} />);
      expect(browser).toHaveAttribute('data-smoothing', 'off');
      expect(screen.queryByText(/Gaussian-smoothed/)).not.toBeInTheDocument();
    }
  });

  it('explains why a sparse scan has no peak track using the returned stride', () => {
    render(<PredictionBrowser jobId="a" refName="chr1" artifacts={browserFiles} summary={{ stride: 20 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('This task used 20 bp; a new 1 bp scan is needed');
    expect(screen.getByTestId('mock-unified-browser')).toHaveAttribute('data-peaks', '');
  });

  it('distinguishes missing peak output from a completed zero-peak result', () => {
    const { rerender } = render(<PredictionBrowser jobId="a" refName="chr1" artifacts={browserFiles} summary={{ stride: 1 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Peak results were not generated');
    rerender(<PredictionBrowser jobId="a" refName="chr1" artifacts={[...browserFiles, { filename: 'peaks.gff3' }]} summary={{ stride: 1, peak_count: 0 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('No peaks passed the calling cutoff');
    expect(screen.getByTestId('mock-unified-browser')).toHaveAttribute('data-peaks', '/api/predictions/jobs/a/artifacts/peaks.gff3');
  });

  it('does not invent a stride for legacy results or show missing-output copy when peaks exist', () => {
    const { rerender } = render(<PredictionBrowser jobId="a" refName="chr1" artifacts={browserFiles} summary={{}} />);
    expect(screen.getByRole('status')).toHaveTextContent('Peak results were not generated');
    expect(screen.getByRole('status')).not.toHaveTextContent('20 bp');
    rerender(<PredictionBrowser jobId="a" refName="chr1" artifacts={[...browserFiles, { filename: 'peaks.gff3' }]} summary={{ peak_count: 3 }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('adds the unindexed peak track only when returned, with service metadata', () => {
    const artifacts = ['input.fasta', 'input.fasta.fai', 'scores.plus.bw', 'peaks.gff3'].map(filename => ({ filename }));
    const { rerender } = render(<PredictionBrowser jobId="a" refName="chr1" artifacts={artifacts} summary={{ smoothing: { method: 'gaussian', sigma: 1, mode: 'reflect' }, peak_calling: { distance: 10, cutoff: .9, operator: '>' } }} />);
    const browser = screen.getByTestId('mock-unified-browser');
    expect(browser).toHaveAttribute('data-peaks', '/api/predictions/jobs/a/artifacts/peaks.gff3');
    expect(browser).toHaveAttribute('data-peaks-index', '');
    expect(browser).toHaveAttribute('data-processing', JSON.stringify({ sigma: 1, distance: 10, cutoff: .9, positionBase: 1 }));
    rerender(<PredictionBrowser jobId="a" refName="chr1" artifacts={artifacts.slice(0, -1)} />);
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
    render(<PredictionBrowser jobId="job-1" refName="chr1" />);

    const browser = screen.getByTestId('mock-unified-browser');
    expect(browser).toHaveAttribute('data-assembly', 'prediction-job-1');
    expect(browser).toHaveAttribute('data-contig-name', 'chr1');
    expect(browser).toHaveAttribute('data-about-label', 'Contig');
    expect(browser).toHaveAttribute('data-locus', 'chr1:1-10000');
    expect(browser).toHaveAttribute('data-fasta', '/api/predictions/jobs/job-1/artifacts/input.fasta');
    expect(browser).toHaveAttribute('data-fai', '/api/predictions/jobs/job-1/artifacts/input.fasta.fai');
    expect(browser).toHaveAttribute('data-scores-plus', '/api/predictions/jobs/job-1/artifacts/scores.plus.bw');
    expect(browser).toHaveAttribute('data-scores-minus', '/api/predictions/jobs/job-1/artifacts/scores.minus.bw');

    await user.upload(screen.getByLabelText('Add GFF3 annotation'), new File([
      '##gff-version 3\nchr1\ttest\tgene\t10\t40\t.\t+\t.\tID=gene1\n',
    ], 'genes.gff3', { type: 'text/plain' }));

    expect(browser).toHaveAttribute('data-annotation', 'blob:annotation');
    expect(browser).toHaveAttribute('data-annotation-label', 'Uploaded annotation · genes.gff3');
    expect(screen.getByText('genes.gff3')).toBeInTheDocument();
  });

  it('uses the contig identifier for display while retaining the task-specific assembly key', () => {
    render(<PredictionBrowser jobId="job-1" refName="NC_000913.3" />);
    const browser = screen.getByTestId('mock-unified-browser');
    expect(browser).toHaveAttribute('data-contig-name', 'NC_000913.3');
    expect(browser).toHaveAttribute('data-assembly', 'prediction-job-1');
  });
});
