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
  it('shows the prediction workspace and a sign-in action to visitors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(
      { authenticated: false, error: { code: 'AUTH_REQUIRED' } },
      { status: 401 },
    )));

    render(<PredictionLayout><PredictPage /></PredictionLayout>);
    expect(screen.getByTestId('prototype-prediction-workbench')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Sign in to submit' })).toHaveAttribute('href', '/login?next=%2Fpredict');
  });
});
