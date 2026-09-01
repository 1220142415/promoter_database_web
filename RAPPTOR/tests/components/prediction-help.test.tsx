// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PredictionHelpPage from '@/app/help/prediction/page';

vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

describe('prediction help', () => {
  it('stays hidden behind the site not-found page', () => {
    expect(() => render(<PredictionHelpPage />)).toThrow('NEXT_NOT_FOUND');
  });
});
