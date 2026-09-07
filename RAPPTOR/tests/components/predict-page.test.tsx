// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PredictPage from '@/app/predict/page';
import PredictionLayout from '@/app/predict/layout';

vi.mock('next/navigation', () => ({ usePathname: () => '/predict' }));

vi.mock('@/features/prediction/prototype/prototype-workbench', () => ({
  default: () => <div data-testid="prototype-prediction-workbench" />,
}));

describe('prediction page', () => {
  afterEach(() => { delete process.env.RAPPTOR_PREDICTION_ACCESS_MODE; });

  it('shows the prediction workspace without login or registration controls', () => {
    process.env.RAPPTOR_PREDICTION_ACCESS_MODE = 'ip';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<PredictionLayout><PredictPage /></PredictionLayout>);
    expect(screen.getByTestId('prototype-prediction-workbench')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sign in/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores the email sign-in bar when email mode is selected', async () => {
    process.env.RAPPTOR_PREDICTION_ACCESS_MODE = 'email';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ authenticated: false }, { status: 401 })));

    render(<PredictionLayout><PredictPage /></PredictionLayout>);

    expect(await screen.findByRole('link', { name: 'Sign in to submit' })).toHaveAttribute('href', '/login?next=%2Fpredict');
  });
});
