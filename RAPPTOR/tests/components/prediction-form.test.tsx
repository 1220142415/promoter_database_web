// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PredictionForm from '@/features/prediction/components/prediction-form';
import { PREDICTION_CONTRACT_VERSION, type PredictionCapabilities } from '@/features/prediction/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const capabilities: PredictionCapabilities = {
  contractVersion: PREDICTION_CONTRACT_VERSION,
  available: true,
  mode: 'demo',
  serviceStatus: 'demo',
  demoPreviewAvailable: true,
  modelVersion: 'rapptor-cgr-100bp-demo-v1',
  supportedPredictionKinds: ['candidate'],
  windowBases: 100,
  predictionAnchorBase: 80,
  promoterThreshold: .9,
  acceptedTargetFormats: ['raw DNA', 'FASTA'],
  acceptedGenomeFormats: ['.fa'],
  limits: { targetMaxBases: 10_000, genomeMaxBytes: 50 * 1024 * 1024 },
  retention: { inputHours: 24, resultDays: 7 },
  turnstileSiteKey: null,
};

describe('prediction form', () => {
  it('shows the explicit demo boundary and validates the 100 bp minimum', async () => {
    const user = userEvent.setup();
    render(<PredictionForm capabilities={capabilities} />);
    expect(screen.getByText('DEMO PREVIEW')).toBeInTheDocument();
    expect(screen.getByText(/80 bp upstream-side segment/)).toHaveTextContent('anchor at base 80');
    expect(screen.getByText(/80 bp upstream-side segment/)).toHaveTextContent('20 bp downstream-side segment');
    expect(screen.getByTestId('demo-turnstile')).toHaveTextContent('Local-only demo preparation');
    await user.type(screen.getByLabelText('Candidate DNA sequence'), 'ACGT');
    expect(screen.getByText('Candidate sequence must contain at least 100 bases.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview demo result' })).toBeDisabled();
  });

  it('loads an example, reports normalized length, and switches to a local-only genome upload', async () => {
    const user = userEvent.setup();
    render(<PredictionForm capabilities={capabilities} />);
    await user.click(screen.getByRole('button', { name: 'Use example' }));
    expect(screen.getByText(/112 bases/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Evaluate both strands/ })).toBeChecked();
    await user.click(screen.getByRole('tab', { name: 'Upload genome FASTA' }));
    expect(screen.getByText('Demo preview computes a checksum locally; the raw file is never uploaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose genome or contigs FASTA/ })).toBeInTheDocument();
  });
});
