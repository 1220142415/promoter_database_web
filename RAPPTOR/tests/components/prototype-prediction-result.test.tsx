// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PrototypePredictionResultView from '@/features/prediction/prototype-result-view';
import {
  DEFAULT_PROTOTYPE_MODEL_SPEC,
  PROTOTYPE_CANDIDATE_GENOME_EXAMPLE,
  PROTOTYPE_GENOME_EXAMPLE,
  writePrototypePredictionRun,
  type PrototypePredictionRun,
} from '@/features/prediction/prototype';

const candidateRun: PrototypePredictionRun = {
  schemaVersion: 2,
  runId: 'prototype_candidate-result-001',
  createdAt: '2026-09-01T00:00:00.000Z',
  mode: 'candidate',
  parameters: { mode: 'candidate', strandMode: 'both', cutoff: .9 },
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
  schemaVersion: 2,
  runId: 'prototype_genome-result-001',
  createdAt: '2026-09-01T00:00:00.000Z',
  mode: 'genome-scan',
  parameters: { mode: 'genome-scan', strandMode: 'both', cutoff: .9, topK: 10 },
  input: { kind: 'genome-scan', genomeContext: PROTOTYPE_GENOME_EXAMPLE },
  modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
};

afterEach(() => window.sessionStorage.clear());

describe('prototype prediction result', () => {
  it('shows focused strand scores and anchors without scan-only result concepts', async () => {
    writePrototypePredictionRun(candidateRun);
    render(<PrototypePredictionResultView runId={candidateRun.runId} />);

    expect(await screen.findByRole('heading', { name: 'Prediction result' })).toBeInTheDocument();
    expect(screen.getByText('Focused 100 bp scoring')).toBeInTheDocument();
    expect(screen.getByText('No model was run')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Focused 100 bp raw scores' })).toBeInTheDocument();
    expect(screen.getAllByText('Illustrative raw score')).toHaveLength(2);
    expect(screen.getByText('Anchor +80')).toBeInTheDocument();
    expect(screen.getByText('Anchor −21')).toBeInTheDocument();
    expect(screen.getByText(/cutoff only labels the score state/i)).toBeInTheDocument();
    expect(screen.queryByText(/raw score curve|top windows|called peak|top results/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Read the interpretation guide' })).toHaveAttribute('href', '/help/prediction#results');
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  });

  it('renders multi-contig raw scores and called peaks without exposing internal peak parameters', async () => {
    writePrototypePredictionRun(genomeRun);
    render(<PrototypePredictionResultView runId={genomeRun.runId} />);

    expect(await screen.findByRole('heading', { name: 'Prediction result' })).toBeInTheDocument();
    expect(screen.getByText('Whole genome / contigs scan')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Raw scores and called peaks' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /demo_contig_A/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /demo_contig_B/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Parquet Live service only/i })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(/sigma|minimum peak distance|minDistance/i);
  });

  it('recovers safely when the tab has no matching session record', async () => {
    render(<PrototypePredictionResultView runId="prototype_missing-run-001" />);
    expect(await screen.findByRole('heading', { name: 'This result is no longer in this tab' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create another prototype run' })).toHaveAttribute('href', '/predict');
    expect(screen.getByText(/copied result URL does not contain the input/i)).toBeInTheDocument();
  });
});
