// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PredictionProgressPanel from '@/features/prediction/components/prediction-progress-panel';

describe('prediction progress panel', () => {
  it('exposes the current scan stage and determinate progress without relying on color', () => {
    render(<PredictionProgressPanel mode="scan" snapshot={{
      state: 'running', stage: 'scanning', percent: 48.4, message: 'Scanning sequence windows.',
      contig: 'contig_A', strand: '-', windows: 1_240,
    }} />);
    expect(screen.getByRole('list', { name: 'Prediction stages' })).toHaveTextContent('Scoring sequence windows');
    expect(screen.getByText('Scoring sequence windows', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Prediction task progress' })).toHaveAttribute('value', '48.4');
    expect(screen.getByRole('status')).toHaveTextContent('Contig contig_A · - strand · 1,240 windows processed');
    expect(screen.getByText('Scoring sequence windows', { selector: 'li span' }).closest('li')).toHaveAttribute('aria-current', 'step');
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
