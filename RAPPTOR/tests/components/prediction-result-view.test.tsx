// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PredictionResultView, { predictionBrowserAssembly, resultTsv } from '@/features/prediction/components/prediction-result-view';
import { PREDICTION_CONTRACT_VERSION, type PredictionJob, type PredictionResult } from '@/features/prediction/types';

const mocks = vi.hoisted(() => ({ predictionApi: vi.fn() }));

vi.mock('@/features/prediction/client', () => ({
  predictionApi: mocks.predictionApi,
  PredictionClientError: class PredictionClientError extends Error {
    retryable = false;
  },
}));

vi.mock('@/features/genome-browser/components/unified-browser-panel', () => ({
  default: ({ prediction }: { prediction: { assemblyName: string } }) => <div data-testid="prediction-jbrowse">{prediction.assemblyName}</div>,
}));

const job: PredictionJob = {
  contractVersion: PREDICTION_CONTRACT_VERSION,
  predictionKind: 'candidate',
  jobId: 'job_abcdefghijklmnop',
  state: 'succeeded',
  progress: 100,
  modelVersion: 'test-model',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:02.000Z',
  resultAvailable: true,
  demo: false,
  message: 'Prediction result is ready.',
};

const result: PredictionResult = {
  contractVersion: PREDICTION_CONTRACT_VERSION,
  predictionKind: 'candidate',
  jobId: job.jobId,
  demo: false,
  modelVersion: 'test-model',
  probabilityThreshold: .9,
  highestProbability: .947,
  bestWindow: { promoterStart: 9, promoterEnd: 108, strand: '+' },
  call: 'model-positive-candidate',
  input: { length: 112, sha256: 'a'.repeat(64), strandMode: 'both' },
  genomeContext: { kind: 'catalog', label: 'GCA_000411415.1', sha256: 'b'.repeat(64), cgrConverterVersion: 'test-cgr' },
  scoreSeries: [
    { windowStart: 1, plus: .3, minus: .2 },
    { windowStart: 9, plus: .947, minus: .4 },
    { windowStart: 13, plus: .5, minus: .8 },
  ],
  topWindows: [
    { rank: 1, probability: .947, strand: '+', promoterStart: 9, promoterEnd: 108 },
    { rank: 2, probability: .8, strand: '-', promoterStart: 13, promoterEnd: 112 },
  ],
  completedAt: '2026-08-28T00:00:02.000Z',
};

afterEach(() => {
  mocks.predictionApi.mockReset();
});

function serve(nextResult: PredictionResult) {
  mocks.predictionApi.mockImplementation((url: string) => Promise.resolve(url.endsWith('/result') ? nextResult : { ...job, jobId: nextResult.jobId, demo: nextResult.demo }));
}

describe('prediction result view', () => {
  it('uses promoter-window terminology and keeps the summary aligned with both-strand input', async () => {
    serve(result);
    render(<PredictionResultView jobId={result.jobId} />);
    expect(await screen.findByText('Both (+/−)')).toBeInTheDocument();
    expect(screen.getAllByText('9–108')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Top promoter windows' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Model score by anchor' })).toBeInTheDocument();
    expect(screen.queryByText(/window intervals ×/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Anchor rule')).not.toBeInTheDocument();
    expect(screen.queryByText('Demo limitation')).not.toBeInTheDocument();
    expect(screen.getByTestId('prediction-window-map')).toHaveTextContent('9–108 · anchor 88 · + strand');
    expect(screen.getByTestId('prediction-window-map')).toHaveTextContent('Base 80 = prediction anchor');
    expect(screen.queryByText(/TSS/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Candidate SHA-256')).not.toBeInTheDocument();
    expect(screen.queryByText('Genome SHA-256')).not.toBeInTheDocument();
    expect(screen.queryByText('CGR converter')).not.toBeInTheDocument();
    expect(screen.queryByText('Candidate', { selector: 'dt' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Prediction context' })).toHaveTextContent('GCA_000411415.1');
    expect(resultTsv(result)).toContain('prediction_anchor_1based\tpromoter_start_1based\tpromoter_end_1based');
    expect(resultTsv(result)).toContain('\t+\t88\t9\t108');
    expect(resultTsv(result).toLowerCase()).not.toContain('tss');
  });

  it('offers the genome browser only for complete, unexpired live assets', async () => {
    const liveResult: PredictionResult = {
      ...result,
      browserAssets: {
        assemblyName: 'candidate-job',
        defaultLocus: 'candidate:1-112',
        expiresAt: '2099-01-01T00:00:00.000Z',
        reference: { fastaUrl: '/result/reference.fa.gz', faiUrl: '/result/reference.fa.gz.fai', gziUrl: '/result/reference.fa.gz.gzi' },
        scores: { plusBigWigUrl: '/result/plus.bw', minusBigWigUrl: '/result/minus.bw' },
        promoters: { gff3Url: '/result/promoters.gff3.gz', indexUrl: '/result/promoters.gff3.gz.tbi' },
      },
    };
    serve(liveResult);
    render(<PredictionResultView jobId={liveResult.jobId} />);
    const switchButton = await screen.findByRole('button', { name: 'Genome browser' });
    await userEvent.click(switchButton);
    expect(await screen.findByTestId('prediction-jbrowse')).toHaveTextContent('candidate-job');
  });

  it('reports forward-only evaluation without implying that both strands ran', async () => {
    const forwardResult: PredictionResult = {
      ...result,
      input: { ...result.input, strandMode: 'forward' },
      scoreSeries: result.scoreSeries.map((point) => ({ ...point, minus: null })),
      topWindows: result.topWindows.filter((window) => window.strand === '+'),
    };
    serve(forwardResult);
    render(<PredictionResultView jobId={forwardResult.jobId} />);
    expect(await screen.findByText('Forward only')).toBeInTheDocument();
    expect(screen.queryByText('Both (+/−)')).not.toBeInTheDocument();
    expect(screen.queryByText('Reverse strand')).not.toBeInTheDocument();
  });

  it('rejects expired browser assets and never enables them for Demo output', async () => {
    const assets = {
      assemblyName: 'candidate-job',
      defaultLocus: 'candidate:1-112',
      expiresAt: '2020-01-01T00:00:00.000Z',
      reference: { fastaUrl: '/reference.fa.gz', faiUrl: '/reference.fa.gz.fai', gziUrl: '/reference.fa.gz.gzi' },
      scores: { plusBigWigUrl: '/plus.bw', minusBigWigUrl: '/minus.bw' },
      promoters: { gff3Url: '/promoters.gff3.gz', indexUrl: '/promoters.gff3.gz.tbi' },
    };
    expect(predictionBrowserAssembly(assets, false, Date.parse('2026-08-28T00:00:00Z'))).toBeNull();
    expect(predictionBrowserAssembly({ ...assets, expiresAt: '2099-01-01T00:00:00Z' }, true)).toBeNull();
    expect(predictionBrowserAssembly({ ...assets, expiresAt: '2099-01-01T00:00:00Z', reference: { ...assets.reference, fastaUrl: 'javascript:alert(1)' } }, false)).toBeNull();

    serve({ ...result, browserAssets: assets });
    render(<PredictionResultView jobId={result.jobId} />);
    await waitFor(() => expect(screen.getByText(/assets are incomplete or expired/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Genome browser' })).not.toBeInTheDocument();
  });
});
