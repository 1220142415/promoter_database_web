// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PredictPage from '@/app/predict/page';
import PredictionLayout from '@/app/predict/layout';

vi.mock('next/navigation', () => ({ usePathname: () => '/predict' }));

vi.mock('@/features/prediction/prototype/prototype-workbench', () => ({
  default: () => <div data-testid="prototype-prediction-workbench" />,
}));

describe('prediction page', () => {
  it('shows the prediction workspace without login or registration controls', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<PredictionLayout><PredictPage /></PredictionLayout>);
    expect(screen.getByTestId('prototype-prediction-workbench')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sign in/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
