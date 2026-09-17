// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PredictionHelpPage from '@/app/help/prediction/page';

describe('prediction help', () => {
  it('renders the prediction help page', () => {
    const { getByRole, getByText } = render(<PredictionHelpPage />);
    expect(getByRole('heading', { name: 'Prediction help' })).toBeTruthy();
    expect(getByRole('heading', { name: 'Prediction workflow' })).toBeTruthy();
    expect(getByRole('heading', { name: 'Genome context and CGR' })).toBeTruthy();
    expect(getByText(/CGR is generated automatically/)).toBeTruthy();
    expect(getByText(/not sufficient by itself to produce a promoter call/)).toBeTruthy();
    expect(getByText('Sequence and reference requirements')).toBeTruthy();
    expect(getByRole('link', { name: 'Back to prediction' })).toHaveAttribute('href', '/predict');
  });
});
