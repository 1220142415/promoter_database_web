// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PrototypePredictionResultView from '@/features/prediction/prototype-result-view';
import {
  DEFAULT_PROTOTYPE_MODEL_SPEC,
  PROTOTYPE_CANDIDATE_GENOME_EXAMPLE,
  writePrototypePredictionRun,
  type PrototypePredictionRun,
} from '@/features/prediction/prototype';

vi.mock('@/features/prediction/prototype/prototype-browser', () => ({
  default: () => <div data-testid="prototype-genome-browser">Reference sequence · Raw score · Called peak</div>,
}));

const candidateRun: PrototypePredictionRun = {
  schemaVersion: 3,
  runId: 'prototype_candidate-result-001',
  createdAt: '2026-09-01T00:00:00.000Z',
  mode: 'candidate',
  parameters: { mode: 'candidate', strandMode: 'both', cutoff: .9, strideBases: 1 },
  input: {
    kind: 'candidate',
    displayName: 'candidate_tutorial',
    format: 'fasta',
    length: 100,
    checksum: 'a'.repeat(64),
    sourceKind: 'inline',
    fileName: null,
    fileSize: null,
    genomeContext: PROTOTYPE_CANDIDATE_GENOME_EXAMPLE,
  },
  modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
};

const genomeRun: PrototypePredictionRun = {
  schemaVersion: 3,
  runId: 'prototype_genome-result-001',
  createdAt: '2026-09-01T00:00:00.000Z',
  mode: 'genome-scan',
  parameters: { mode: 'genome-scan', strandMode: 'both', cutoff: .9, strideBases: 1 },
  input: { kind: 'genome-scan', scanSource: PROTOTYPE_CANDIDATE_GENOME_EXAMPLE, genomeContext: PROTOTYPE_CANDIDATE_GENOME_EXAMPLE },
  modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
};

afterEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe('prototype prediction result', () => {
  it('shows simulated queue progress before revealing the focused result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
    const queuedRun: PrototypePredictionRun = { ...candidateRun, runId: 'prototype_candidate-queued-001', createdAt: '2026-09-02T12:00:00.000Z' };
    writePrototypePredictionRun(queuedRun);
    render(<PrototypePredictionResultView runId={queuedRun.runId} />);

    expect(screen.getByRole('region', { name: 'Prediction progress' })).toHaveTextContent('Waiting in queue');
    expect(screen.getByRole('progressbar', { name: 'Prediction task progress' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '100 bp result' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(screen.getByRole('region', { name: 'Prediction progress' })).toHaveTextContent('Result ready');
    expect(screen.getByRole('heading', { name: '100 bp result' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Download (GFF3|bedGraph)/i })).toHaveLength(2);
  });

  it('shows a compact focused strand comparison without anchor or scan-only result concepts', async () => {
    writePrototypePredictionRun(candidateRun);
    render(<PrototypePredictionResultView runId={candidateRun.runId} />);

    expect(await screen.findByRole('heading', { name: 'Prediction result' })).toBeInTheDocument();
    expect(screen.getByText('100 bp scoring')).toBeInTheDocument();
    expect(screen.getByText('Demo only: deterministic fixture values; no model was run.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '100 bp result' })).toBeInTheDocument();
    expect(screen.getAllByText('Illustrative model score')).toHaveLength(2);
    expect(screen.getByRole('meter', { name: /Forward strand.*illustrative model score/ })).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: /Reverse strand.*illustrative model score/ })).toBeInTheDocument();
    expect(screen.queryByText('100 bp anchor positions')).not.toBeInTheDocument();
    expect(screen.queryByText(/Anchor base/)).not.toBeInTheDocument();
    expect(screen.getAllByText('At or below threshold')).toHaveLength(2);
    expect(screen.getByText(/threshold changes classification only/i)).toBeInTheDocument();
    expect(screen.queryByText(/raw score curve|top windows|called peak|top results/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read the interpretation guide' })).not.toBeInTheDocument();
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  });

  it('uses the genome browser for scan results without exposing internal peak parameters', async () => {
    writePrototypePredictionRun(genomeRun);
    render(<PrototypePredictionResultView runId={genomeRun.runId} />);

    expect(await screen.findByRole('heading', { name: 'Prediction result' })).toBeInTheDocument();
    expect(screen.getByText('Sequence scan')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Genome browser' })).toBeInTheDocument();
    expect(await screen.findByTestId('prototype-genome-browser')).toHaveTextContent('Reference sequence · Raw score · Called peak');
    expect(screen.getAllByRole('button', { name: /Download (GFF3|bedGraph)/i })).toHaveLength(2);
    expect(screen.queryByText('Top called peaks')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/sigma|minimum peak distance|minDistance/i);
  });

  it('recovers safely when the tab has no matching session record', async () => {
    render(<PrototypePredictionResultView runId="prototype_missing-run-001" />);
    expect(await screen.findByRole('heading', { name: 'This result is no longer in this tab' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create another prototype run' })).toHaveAttribute('href', '/predict');
    expect(screen.getByText(/copied URLs contain no input/i)).toBeInTheDocument();
  });
});
