// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PredictionProgressPanel from '@/features/prediction/components/prediction-progress-panel';

describe('prediction progress panel', () => {
  it('exposes the current scan stage and determinate progress without relying on color', () => {
    render(<PredictionProgressPanel mode="scan" snapshot={{
      state: 'running', stage: 'scanning', percent: 48.4, message: 'Scanning sequence windows.',
      contig: 'contig_A', strand: '-', windows: 1_240, totalWindows: 4_000,
    }} />);
    expect(screen.getByRole('list', { name: 'Prediction stages' })).toHaveTextContent('Scoring sequence windows');
    expect(screen.getByText('Scoring sequence windows', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Prediction task progress' })).toHaveAttribute('value', '48.4');
    const scan = screen.getByRole('region', { name: 'Genome scan progress' });
    expect(scan).toHaveTextContent('Sequence: contig_A · Reverse strand (−)');
    expect(scan).toHaveTextContent('1,240 / 4,000');
    expect(within(scan).getByRole('progressbar', { name: 'Scanned windows' })).toHaveAttribute('value', '31');
    expect(within(scan).getByText('31%')).toBeInTheDocument();
    expect(screen.getByText('Scoring sequence windows', { selector: 'li span' }).closest('li')).toHaveAttribute('aria-current', 'step');
  });

  it('keeps legacy scan progress indeterminate instead of converting overall percent into scan percent', () => {
    render(<PredictionProgressPanel mode="scan" snapshot={{ state: 'running', stage: 'scanning', percent: 52.5, windows: 123, message: 'Scanning.' }} />);
    const scan = screen.getByRole('region', { name: 'Genome scan progress' });
    expect(within(scan).getByRole('progressbar')).not.toHaveAttribute('value');
    expect(scan).toHaveTextContent('123');
    expect(scan).toHaveTextContent('Total window count is not available');
    expect(scan).not.toHaveTextContent('52.5%');
  });

  it('separates a complete scan from unfinished output generation', () => {
    render(<PredictionProgressPanel mode="scan" snapshot={{ state: 'running', stage: 'writing_outputs', percent: 92, windows: 4000, totalWindows: 4000, message: 'Preparing browser tracks.' }} />);
    expect(screen.getByRole('progressbar', { name: 'Prediction task progress' })).toHaveAttribute('value', '92');
    expect(screen.getByRole('region', { name: 'Genome scan progress' })).toHaveTextContent('Scan complete');
    expect(screen.getByRole('progressbar', { name: 'Scanned windows' })).toHaveAttribute('value', '100');
  });

  it('shows an empty scan without an endless progressbar', () => {
    render(<PredictionProgressPanel mode="scan" snapshot={{ state: 'running', stage: 'writing_outputs', percent: 92, windows: 0, totalWindows: 0, message: 'Preparing result files.' }} />);
    const scan = screen.getByRole('region', { name: 'Genome scan progress' });
    expect(scan).toHaveTextContent('No windows to scan');
    expect(within(scan).queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('returns to the compact result-ready display after completion', () => {
    render(<PredictionProgressPanel mode="scan" snapshot={{ state: 'succeeded', stage: 'complete', percent: 100, windows: 4000, totalWindows: 4000, message: 'Result ready.' }} />);
    expect(screen.queryByRole('region', { name: 'Genome scan progress' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('4,000 windows processed');
  });

  it('marks an interrupted scan as stopped and retains the last processed count', () => {
    render(<PredictionProgressPanel mode="scan" snapshot={{ state: 'failed', stage: 'scanning', percent: 45, windows: 400, totalWindows: 1000, message: 'Worker stopped.' }} />);
    expect(screen.getByRole('region', { name: 'Genome scan progress' })).toHaveTextContent('Scan stopped');
    expect(screen.getByRole('progressbar', { name: 'Scanned windows' })).toHaveAttribute('value', '40');
  });

  it('uses an indeterminate progressbar for missing percentages and handles failures', async () => {
    const retry = vi.fn();
    render(<PredictionProgressPanel mode="focused" snapshot={{ state: 'failed', stage: 'failed', percent: null, message: 'Worker stopped.' }} onRetry={retry} />);
    expect(screen.getByRole('progressbar', { name: 'Prediction task progress' })).not.toHaveAttribute('value');
    expect(screen.getByText('Prediction failed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return to prediction input' })).toHaveAttribute('href', '/predict');
    await userEvent.click(screen.getByRole('button', { name: 'Check status again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('identifies simulated progress as a queue preview rather than a model result', () => {
    render(<PredictionProgressPanel mode="focused" snapshot={{ state: 'queued', stage: 'queued', percent: 3, message: 'Waiting for an available worker.', simulated: true }} />);
    expect(screen.getByText('Simulated queue preview')).toBeInTheDocument();
    expect(screen.getByText(/no model was run/i)).toBeInTheDocument();
    expect(screen.queryByText(/queue position|estimated/i)).not.toBeInTheDocument();
  });
});
