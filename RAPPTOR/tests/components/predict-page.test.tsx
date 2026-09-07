// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PredictPage from '@/app/predict/page';
import PredictionLayout from '@/app/predict/layout';

vi.mock('@/features/prediction/service-capabilities', () => ({ queuedPredictionLocalTest: () => false, queuedPredictionCapabilities: vi.fn(async () => ({ available: false, modelVersion: 'candidate-github-93cf', supportsScoreCutoff: false, siteKey: '' })) }));

vi.mock('next/navigation', () => ({ usePathname: () => '/predict' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'localhost:3000' }) }));

vi.mock('@/features/prediction/prototype/prototype-workbench', () => ({
  default: () => <div data-testid="prototype-prediction-workbench" />,
}));

describe('prediction page', () => {
  it('shows the prediction workspace without login or registration controls', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<PredictionLayout>{await PredictPage()}</PredictionLayout>);
    expect(screen.getByTestId('prototype-prediction-workbench')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sign in/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
