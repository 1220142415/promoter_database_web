// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('prediction workspace layout', () => {
  beforeEach(() => {
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
              { filename: 'summary.json', format: 'json', size_bytes: 30, sha256: 'ghi' },
            ] },
          },
    })));
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
});
