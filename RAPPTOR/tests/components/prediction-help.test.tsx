// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PredictionHelpPage from '@/app/help/prediction/page';

describe('prediction help', () => {
  it('renders the prediction help page', () => {
    const { getByRole } = render(<PredictionHelpPage />);
    expect(getByRole('heading', { name: 'Prediction help' })).toBeTruthy();
  });
});
