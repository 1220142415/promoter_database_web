// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PredictPage from '@/app/predict/page';

vi.mock('@/features/prediction/prototype/prototype-workbench', () => ({
  default: () => <div data-testid="prototype-prediction-workbench" />,
}));

describe('hidden prediction page', () => {
  it('remains directly accessible with the latest prototype interface', () => {
    render(<PredictPage />);
    expect(screen.getByTestId('prototype-prediction-workbench')).toBeInTheDocument();
  });
});
