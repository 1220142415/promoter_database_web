// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PredictPage from '@/app/predict/page';

vi.mock('@/features/prediction/components/prediction-workbench', () => ({
  default: () => <div data-testid="prediction-workbench" />,
}));
vi.mock('@/features/prediction/prototype/prototype-workbench', () => ({
  default: () => <div data-testid="prototype-prediction-workbench" />,
}));

const originalPredictionEnabled = process.env.RAPPTOR_PREDICTION_ENABLED;

afterEach(() => {
  if (originalPredictionEnabled === undefined) delete process.env.RAPPTOR_PREDICTION_ENABLED;
  else process.env.RAPPTOR_PREDICTION_ENABLED = originalPredictionEnabled;
});

describe('hidden prediction page', () => {
  it('remains directly accessible as a prototype without a public service flag', () => {
    delete process.env.RAPPTOR_PREDICTION_ENABLED;
    render(<PredictPage />);
    expect(screen.getByTestId('prototype-prediction-workbench')).toBeInTheDocument();
    expect(screen.queryByTestId('prediction-workbench')).not.toBeInTheDocument();
  });

  it('shows the queued service when its public flag is enabled', () => {
    process.env.RAPPTOR_PREDICTION_ENABLED = 'on';
    render(<PredictPage />);
    expect(screen.getByRole('heading', { name: 'Run RAPPTOR' })).toBeInTheDocument();
    expect(screen.getByTestId('prediction-workbench')).toBeInTheDocument();
  });
});
