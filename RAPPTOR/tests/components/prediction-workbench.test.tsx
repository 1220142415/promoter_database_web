// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PredictionWorkbench from '@/features/prediction/components/prediction-workbench';
import { PREDICTION_HISTORY_KEY, type PredictionHistoryEntry } from '@/features/prediction/history';

vi.mock('next/dynamic', () => ({
  default: () => ({ refName, accessToken }: { refName: string; accessToken: string }) => (
    <div data-testid="live-prediction-browser" data-reference={refName} data-access-token={accessToken}>
      Live genome browser
    </div>
  ),
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

function mockApi(mode: PredictionHistoryEntry['mode'], options: { sessionStatus?: number; missingArtifacts?: string[]; fai?: string } = {}) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/session')) return new Response(null, { status: options.sessionStatus || 200 });
    if (String(input).endsWith('/artifacts/input.fasta.fai')) return new Response(options.fai || 'chr1\t320\t6\t60\t61\n');
    const job = completedJob(mode);
    job.result.artifacts = job.result.artifacts.filter((item) => !options.missingArtifacts?.includes(item.filename));
    return Response.json(String(input).endsWith('/artifacts/summary.json')
      ? mode === 'predict'
        ? { mode: 'predict', sequence_bases: 100, genome_context_bases: 4_641_652, window_count: 2, max_score: 0.3121 }
        : { mode: 'genome_scan', total_bases: 320, genome_context_bases: 320, contig_count: 1, window_count: 442, passing_window_count: 7, stride: 1 }
      : String(input).endsWith('/artifacts/scores.json')
        ? [{ strand: '+', score: 0.3121, window_start_0based: 0, anchor_position_0based: 80 }, { strand: '-', score: 0.1842, window_start_0based: 0, anchor_position_0based: 19 }]
        : job);
  }));
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
    expect(screen.getByTestId('live-prediction-browser')).toHaveAttribute('data-access-token', saved.token);
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
    expect(await screen.findByRole('meter', { name: 'Forward strand model score' })).toHaveAttribute('value', '0.3121');
    expect(screen.getByRole('meter', { name: 'Reverse strand model score' })).toHaveAttribute('value', '0.1842');
    expect(screen.queryByText(/did not request GFF3/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Genome browser' })).not.toBeInTheDocument();
  });

  it('does not load artifacts when the artifact session rejects access', async () => {
    mockApi('genome_scan', { sessionStatus: 401 });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Task access is invalid or has expired');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/artifacts/'))).toBe(false);
    expect(screen.queryByTestId('live-prediction-browser')).not.toBeInTheDocument();
  });

  it('reports a missing summary instead of leaving the completed result blank', async () => {
    mockApi('genome_scan', { missingArtifacts: ['summary.json'] });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no summary.json artifact');
    expect(screen.queryByTestId('live-prediction-browser')).not.toBeInTheDocument();
  });

  it('requires the reverse track for a both-strand scan', async () => {
    mockApi('genome_scan', { missingArtifacts: ['scores.minus.bw'] });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('scores.minus.bw');
    expect(screen.queryByTestId('live-prediction-browser')).not.toBeInTheDocument();
  });

  it('recovers the reference name from the returned index for a shared task', async () => {
    localStorage.clear();
    sessionStorage.clear();
    window.location.hash = 'access=shared_access_token_1234567890abcdef';
    mockApi('genome_scan', { fai: 'NC_000913.3\t4641652\t73\t70\t71\n' });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByTestId('live-prediction-browser')).toHaveAttribute('data-reference', 'NC_000913.3');
  });

  it('does not use summary max_score as a substitute for missing strand scores', async () => {
    mockApi('predict', { missingArtifacts: ['scores.json'] });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no scores.json artifact');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });
});
