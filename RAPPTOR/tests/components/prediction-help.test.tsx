// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PredictionHelpPage from '@/app/help/prediction/page';

describe('prediction help', () => {
  it('renders the prediction help page', () => {
    const { getByRole, getByText } = render(<PredictionHelpPage />);
    expect(getByRole('heading', { name: 'Prediction help' })).toBeTruthy();
    expect(getByRole('heading', { name: 'Choose an analysis' })).toBeTruthy();
    expect(getByRole('heading', { name: 'How to interpret the CGR choice' })).toBeTruthy();
    expect(getByText(/How promoter-like is this sequence in the context of this genome/)).toBeTruthy();
    expect(getByText(/Scored windows/)).toBeTruthy();
    expect(getByRole('link', { name: 'Back to prediction' })).toHaveAttribute('href', '/predict');
  });
});
