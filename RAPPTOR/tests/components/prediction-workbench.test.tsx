// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PredictionWorkbench from '@/features/prediction/components/prediction-workbench';
import { PREDICTION_HISTORY_KEY, type PredictionHistoryEntry } from '@/features/prediction/history';

vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="mock-prediction-browser" />,
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

describe('prediction workspace layout', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
    localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify([saved]));
    sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(saved));
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input).endsWith('/artifacts/summary.json')
        ? { mode: 'genome_scan', total_bases: 320, window_count: 442, stride: 1, contig_count: 1 }
        : {
            job_id: saved.jobId,
            status: 'succeeded',
            artifacts_expires_at: '2026-08-30T09:25:25Z',
            result: { artifacts: [
              { filename: 'scores.gff3', format: 'gff3', size_bytes: 10, sha256: 'abc' },
              { filename: 'scores.plus.bw', format: 'bigwig', size_bytes: 20, sha256: 'def' },
              { filename: 'scores.minus.bw', format: 'bigwig', size_bytes: 20, sha256: 'def2' },
              { filename: 'input.fasta', format: 'fasta', size_bytes: 320, sha256: 'fasta' },
              { filename: 'input.fasta.fai', format: 'fai', size_bytes: 32, sha256: 'fai' },
              { filename: 'summary.json', format: 'json', size_bytes: 30, sha256: 'ghi' },
            ] },
          },
    })));
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  });

  it('keeps New first in the right rail and shows one selected job in the main workspace', async () => {
    const user = userEvent.setup();
    render(<PredictionWorkbench siteKey="" modelVersion="test" localTest />);

    await waitFor(() => expect(screen.getByText('SELECTED PREDICTION')).toBeInTheDocument());
    expect(screen.getByText(/Available until/)).toBeInTheDocument();
    expect(screen.queryByText(/Technical files/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Run statistics')).toBeInTheDocument());
    expect(screen.getByText('442')).toBeInTheDocument();
    const recent = screen.getByRole('complementary', { name: 'Recent predictions' });
    expect(recent).toHaveTextContent('＋ New prediction');
    expect(recent).toHaveTextContent('recent-genome.fna');
    expect(screen.queryByText('INPUT WORKBENCH')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /New prediction/ }));
    expect(screen.getByText('INPUT WORKBENCH')).toBeInTheDocument();
    expect(screen.queryByText('SELECTED PREDICTION')).not.toBeInTheDocument();
    expect(recent).toHaveTextContent('recent-genome.fna');
  });

  it.each(['failed', 'unknown'])('shows an actual %s task instead of running progress', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ job_id: saved.jobId, status, error: status === 'failed' ? { message: 'Model worker failed to load its checkpoint.' } : undefined })));
    render(<PredictionWorkbench siteKey="" modelVersion="test" localTest initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(status === 'failed' ? 'Model worker failed' : 'unavailable or has expired');
    expect(screen.queryByTestId('mock-prediction-browser')).not.toBeInTheDocument();
  });

  it('stops before loading artifacts when the access session is rejected', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/session')
      ? new Response(null, { status: 401 })
      : Response.json({ job_id: saved.jobId, status: 'succeeded', result: { artifacts: [{ filename: 'summary.json' }] } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PredictionWorkbench siteKey="" modelVersion="test" localTest initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/artifacts/'))).toBe(false);
  });

  it('reports a missing summary rather than silently displaying an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ job_id: saved.jobId, status: 'succeeded', result: { artifacts: [] } })));
    render(<PredictionWorkbench siteKey="" modelVersion="test" localTest initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no summary.json');
  });

  it('reports missing genome tracks after a successful task', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).endsWith('/summary.json')
      ? { mode: 'genome_scan', reverse_complementary: true }
      : { job_id: saved.jobId, status: 'succeeded', result: { artifacts: [{ filename: 'summary.json' }] } })));
    render(<PredictionWorkbench siteKey="" modelVersion="test" localTest initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Required browser artifacts are missing');
    expect(screen.queryByTestId('mock-prediction-browser')).not.toBeInTheDocument();
  });

  it('opens an emailed task link from browser history when session storage is empty', async () => {
    sessionStorage.clear();
    render(<PredictionWorkbench siteKey="" modelVersion="test" localTest initialJobId={saved.jobId} />);

    await waitFor(() => expect(screen.getByText('SELECTED PREDICTION')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(`/api/predictions/jobs/${saved.jobId}`, expect.objectContaining({
      headers: { 'X-Job-Token': saved.token },
    }));
    expect(sessionStorage.getItem('rapptor-prediction-job')).toContain(saved.jobId);
  });

  it('opens a capability link in a browser with no prior task history', async () => {
    const sharedToken = 'shared_access_token_1234567890abcdef';
    localStorage.clear();
    sessionStorage.clear();
    window.location.hash = `access=${sharedToken}&ref=shared_chr`;

    render(<PredictionWorkbench siteKey="" modelVersion="test" localTest initialJobId={saved.jobId} />);

    await waitFor(() => expect(screen.getByTestId('mock-prediction-browser')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(`/api/predictions/jobs/${saved.jobId}`, expect.objectContaining({
      headers: { 'X-Job-Token': sharedToken },
    }));
    expect(screen.getAllByText('shared_chr')).not.toHaveLength(0);
    expect(localStorage.getItem(PREDICTION_HISTORY_KEY)).toContain(sharedToken);
  });
});
