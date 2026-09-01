// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PredictionBrowser from '@/features/prediction/components/prediction-browser';

vi.mock('@/features/genome-browser/components/unified-browser-panel', () => ({
  default: ({ prediction }: { prediction: {
    assemblyName: string;
    defaultLocus: string;
    assets: Record<string, string | null>;
    trackLabels?: { annotation?: string };
  } }) => <div
    data-testid="mock-unified-browser"
    data-assembly={prediction.assemblyName}
    data-locus={prediction.defaultLocus}
    data-fasta={prediction.assets.fasta}
    data-fai={prediction.assets.fastaFai}
    data-scores-plus={prediction.assets.promoterScoresPlus}
    data-scores-minus={prediction.assets.promoterScoresMinus}
    data-annotation={prediction.assets.ncbiAnnotations || ''}
    data-annotation-label={prediction.trackLabels?.annotation || ''}
  />,
}));

describe('prediction browser tracks', () => {
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
});
