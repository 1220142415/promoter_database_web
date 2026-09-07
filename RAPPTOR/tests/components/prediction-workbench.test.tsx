// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PredictionWorkbench from '@/features/prediction/components/prediction-workbench';
import { PREDICTION_HISTORY_KEY, type PredictionHistoryEntry } from '@/features/prediction/history';

vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="live-prediction-browser">Live genome browser</div>,
}));

vi.mock('@/features/prediction/components/prediction-browser', () => ({
  default: () => <div data-testid="live-prediction-browser">Live genome browser</div>,
}));

const saved: PredictionHistoryEntry = {
  jobId: '8242cc4cdaae4f07ab082dad6e3238fe',
  token: 'test-token',
  refName: 'chr1',
  status: 'succeeded',
  mode: 'genome_scan',
  submittedAt: '2026-08-29T09:25:25Z',
  label: 'recent-genome.fna',
  bases: 320,
  cutoff: 0.9,
  strandMode: 'both',
  strideBases: 1,
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function completedJob(mode: PredictionHistoryEntry['mode']) {
  return {
    job_id: saved.jobId,
    status: 'succeeded',
    model_version: 'candidate-github-93cf',
    submitted_at: saved.submittedAt,
    artifacts_expires_at: '2026-09-08T09:25:25Z',
    result: { artifacts: mode === 'predict' ? [
      { filename: 'scores.json', format: 'json', size_bytes: 200, sha256: 'scores' },
      { filename: 'summary.json', format: 'json', size_bytes: 100, sha256: 'summary' },
    ] : [
      { filename: 'scores.gff3', format: 'gff3', size_bytes: 10, sha256: 'gff' },
      { filename: 'scores.plus.bw', format: 'bigwig', size_bytes: 20, sha256: 'plus' },
      { filename: 'scores.minus.bw', format: 'bigwig', size_bytes: 20, sha256: 'minus' },
      { filename: 'input.fasta', format: 'fasta', size_bytes: 320, sha256: 'fasta' },
      { filename: 'input.fasta.fai', format: 'fai', size_bytes: 32, sha256: 'fai' },
      { filename: 'summary.json', format: 'json', size_bytes: 100, sha256: 'summary' },
    ] },
  };
}

function mockApi(mode: PredictionHistoryEntry['mode']) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => String(input).endsWith('/artifacts/summary.json')
      ? mode === 'predict'
        ? { mode: 'predict', sequence_bases: 100, genome_context_bases: 4_641_652, window_count: 2, max_score: 0.3121 }
        : { mode: 'genome_scan', total_bases: 320, genome_context_bases: 320, contig_count: 1, window_count: 442, passing_window_count: 7, stride: 1 }
      : String(input).endsWith('/artifacts/scores.json')
        ? [{ strand: '+', score: 0.3121 }, { strand: '-', score: 0.1842 }]
        : completedJob(mode),
  }) as unknown as Response));
}

describe('live prediction result layout', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
    localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify([saved]));
    sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(saved));
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  });

  it('uses the same result design as the colleague prototype for a live genome scan', async () => {
    mockApi('genome_scan');
    render(<PredictionWorkbench initialJobId={saved.jobId} />);

    expect(await screen.findByRole('heading', { name: 'Prediction result' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Genome browser' })).toBeInTheDocument();
    expect(screen.getByTestId('live-prediction-browser')).toBeInTheDocument();
    expect(screen.getByText('442')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('Recent predictions')).not.toBeInTheDocument();
    expect(screen.queryByText('Prediction service ready')).not.toBeInTheDocument();
  });

  it('opens a capability link in a browser with no stored task history', async () => {
    mockApi('genome_scan');
    localStorage.clear();
    sessionStorage.clear();
    const sharedToken = 'shared_access_token_1234567890abcdef';
    window.location.hash = `access=${sharedToken}&ref=shared_chr`;

    render(<PredictionWorkbench initialJobId={saved.jobId} />);

    expect(await screen.findByRole('heading', { name: 'Genome browser' })).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/predictions/jobs/${saved.jobId}`, expect.objectContaining({
      headers: { 'X-Job-Token': sharedToken },
    })));
    expect(localStorage.getItem(PREDICTION_HISTORY_KEY)).toContain(sharedToken);
  });

  it('shows real focused strand scores instead of the old empty GFF3 panel', async () => {
    const focused = { ...saved, mode: 'predict' as const, label: 'Candidate sequence', bases: 4_641_752 };
    localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify([focused]));
    sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(focused));
    mockApi('predict');

    render(<PredictionWorkbench initialJobId={saved.jobId} />);

    expect(await screen.findByRole('heading', { name: '100 bp result' })).toBeInTheDocument();
    expect(await screen.findByRole('meter', { name: 'Forward strand (+) model score' })).toHaveAttribute('aria-valuenow', '0.3121');
    expect(screen.getByRole('meter', { name: 'Reverse strand (−) model score' })).toHaveAttribute('aria-valuenow', '0.1842');
    expect(screen.queryByText(/did not request GFF3/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Genome browser' })).not.toBeInTheDocument();
  });
});
