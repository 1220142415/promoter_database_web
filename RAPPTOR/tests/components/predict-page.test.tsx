// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PredictPage from '@/app/predict/page';
import PredictionLayout from '@/app/predict/layout';
import { queuedPredictionLocalTest } from '@/features/prediction/service-capabilities';

vi.mock('@/features/prediction/service-capabilities', () => ({ queuedPredictionLocalTest: vi.fn(() => false), queuedPredictionCapabilities: vi.fn(async () => ({ available: false, modelVersion: 'candidate-github-93cf', supportsScoreCutoff: false, siteKey: '' })) }));

vi.mock('next/navigation', () => ({ usePathname: () => '/predict' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'localhost:3000' }) }));

vi.mock('@/features/prediction/prototype/prototype-workbench', () => ({
  default: () => <div data-testid="prototype-prediction-workbench" />,
}));

describe('prediction page', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it('shows the prediction workspace without login or registration controls', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_ACCESS_MODE', 'ip');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<PredictionLayout>{await PredictPage()}</PredictionLayout>);
    expect(screen.getByTestId('prototype-prediction-workbench')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sign in/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores the email sign-in bar when email mode is selected', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_ACCESS_MODE', 'email');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ authenticated: false }, { status: 401 })));

    render(<PredictionLayout>{await PredictPage()}</PredictionLayout>);

    expect(await screen.findByRole('link', { name: 'Sign in to submit' })).toHaveAttribute('href', '/login?next=%2Fpredict');
  });

  it('allows the verified local test workspace even in email mode', async () => {
    vi.stubEnv('RAPPTOR_PREDICTION_ACCESS_MODE', 'email');
    vi.mocked(queuedPredictionLocalTest).mockReturnValueOnce(true);
    vi.stubGlobal('fetch', vi.fn());
    render(<PredictionLayout>{await PredictPage()}</PredictionLayout>);
    expect(screen.getByTestId('prototype-prediction-workbench')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in to submit' })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
