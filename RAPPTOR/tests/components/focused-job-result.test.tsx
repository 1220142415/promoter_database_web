// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FocusedJobResult from '@/features/prediction/components/focused-job-result';

afterEach(() => vi.unstubAllGlobals());
describe('protected 100 bp result', () => {
  it('reports expired access and retries the same score artifact', async () => {
    const scores = [{ strand: '+', score: .37, window_start_0based: 0, anchor_position_0based: 79 }, { strand: '-', score: .62, window_start_0based: 0, anchor_position_0based: 20 }];
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(Response.json(scores));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<FocusedJobResult jobId="test-job" bothStrands hasScores />);
    expect(await screen.findByRole('alert')).toHaveTextContent('access has expired');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry score download' }));
    expect(await screen.findByRole('meter', { name: 'Forward strand model score' })).toHaveAttribute('value', '0.37');
    expect(screen.getByRole('meter', { name: 'Reverse strand model score' })).toHaveAttribute('value', '0.62');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('/api/predictions/jobs/test-job/artifacts/scores.json'));
  });
  it('reports a missing artifact without inventing a score', async () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<FocusedJobResult jobId="test-job" bothStrands hasScores={false} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no scores.json');
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });
  it('shows an observed forward score while explicitly failing missing reverse-strand verification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ strand: '+', score: .37, window_start_0based: 0, anchor_position_0based: 80 }])));
    render(<FocusedJobResult jobId="partial-job" bothStrands hasScores />);
    expect(await screen.findByRole('meter', { name: 'Forward strand model score' })).toHaveAttribute('value', '0.37');
    expect(screen.getByRole('alert')).toHaveTextContent('reverse-strand result is missing');
    expect(screen.queryByRole('meter', { name: 'Reverse strand model score' })).not.toBeInTheDocument();
  });
  it('continues to reject invalid single-row data rather than calling it a partial result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ strand: '+', score: 8, window_start_0based: 0, anchor_position_0based: 80 }])));
    render(<FocusedJobResult jobId="invalid-job" bothStrands hasScores />);
    expect(await screen.findByRole('alert')).toHaveTextContent('artifact is invalid');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });
});
