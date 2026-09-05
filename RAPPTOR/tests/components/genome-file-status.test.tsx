// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import GenomeFileStatus from '@/features/genome-browser/components/genome-file-status';

describe('genome file status', () => {
  it('shows determinate and indeterminate download progress without hiding failures', () => {
    render(<GenomeFileStatus
      states={{ reference: 'preparing', promoters: 'preparing', scores: 'failed', annotation: 'unavailable' }}
      progress={{
        reference: { label: 'Downloading 42%', value: 42 },
        promoters: { label: 'Decompressing' },
        scores: { label: 'Checking size' },
      }}
    />);

    expect(screen.getByRole('progressbar', { name: 'Reference: Downloading 42%' })).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByRole('progressbar', { name: 'Promoter predictions: Decompressing' })).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByLabelText('Genome files')).toHaveTextContent('Model scoresFailed');
  });
});
