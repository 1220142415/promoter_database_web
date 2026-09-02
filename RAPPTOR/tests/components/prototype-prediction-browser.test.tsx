// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PrototypePredictionBrowser from '@/features/prediction/prototype/prototype-browser';
import {
  DEFAULT_PROTOTYPE_MODEL_SPEC,
  createPrototypeFixture,
  parsePrototypeSequenceInput,
  type PrototypeGenomeScanRun,
} from '@/features/prediction/prototype';
import {
  clearPrototypeTransientInput,
  readPrototypeTransientInput,
  registerPrototypeTransientInput,
} from '@/features/prediction/prototype/transient-input';

vi.mock('@/features/genome-browser/components/unified-browser-panel', () => ({
  default: ({ prediction }: { prediction: {
    assemblyName: string;
    defaultLocus: string;
    allowShareView?: boolean;
    assets: { fasta: string };
    prototypeTracks?: { rawScoresBedGraphPlus: string; rawScoresBedGraphMinus: string | null; calledPeaksGff3: string } | null;
    trackLabels?: { reference?: string };
  } }) => <div
    data-testid="mock-prototype-browser-panel"
    data-assembly={prediction.assemblyName}
    data-locus={prediction.defaultLocus}
    data-reference-label={prediction.trackLabels?.reference}
    data-reference-url={prediction.assets.fasta}
    data-plus-url={prediction.prototypeTracks?.rawScoresBedGraphPlus}
    data-minus-url={prediction.prototypeTracks?.rawScoresBedGraphMinus || ''}
    data-peaks-url={prediction.prototypeTracks?.calledPeaksGff3}
    data-sharing={String(prediction.allowShareView)}
  />,
}));

function genomeRun(runId = 'prototype-browser-test') : PrototypeGenomeScanRun {
  return {
    schemaVersion: 3,
    runId,
    createdAt: '2026-09-02T00:00:00.000Z',
    modelSpec: DEFAULT_PROTOTYPE_MODEL_SPEC,
    mode: 'genome-scan',
    parameters: { mode: 'genome-scan', strandMode: 'both', cutoff: .5, strideBases: 1 },
    input: {
      kind: 'genome-scan',
      scanSource: {
        kind: 'inline',
        displayName: 'Pasted sequences',
        fileName: null,
        fileSize: null,
        checksum: 'b'.repeat(64),
        totalLength: 900,
        contigs: [
          { sequenceId: 'contig_alpha', length: 500 },
          { sequenceId: 'contig_beta', length: 400 },
        ],
      },
      genomeContext: {
        kind: 'upload',
        displayName: 'matching-context.fna',
        fileName: 'matching-context.fna',
        fileSize: 1_000,
        checksum: 'c'.repeat(64),
        totalLength: 1_000,
        contigs: [{ sequenceId: 'context_contig', length: 1_000 }],
      },
    },
  };
}

describe('prototype prediction browser', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    let index = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:prototype-${++index}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    clearPrototypeTransientInput('prototype-browser-test');
    clearPrototypeTransientInput('prototype-browser-fallback');
    vi.restoreAllMocks();
  });

  it('keeps a submitted sequence only in a defensive in-memory handoff', () => {
    const parsed = parsePrototypeSequenceInput([
      '>contig_alpha',
      'ACGT'.repeat(125),
      '>contig_beta',
      'TGCA'.repeat(100),
    ].join('\n'));

    registerPrototypeTransientInput('prototype-browser-test', parsed);

    const firstRead = readPrototypeTransientInput('prototype-browser-test');
    expect(firstRead?.records[0].normalizedSequence).toHaveLength(500);
    const shortenedCopy = firstRead?.records.slice(1);
    expect(shortenedCopy).toHaveLength(1);
    expect(readPrototypeTransientInput('prototype-browser-test')?.records).toHaveLength(2);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('creates private object-URL assets for submitted FASTA and exposes separate raw-score and called-peak tracks', async () => {
    const run = genomeRun();
    const fixture = createPrototypeFixture(run);
    const parsed = parsePrototypeSequenceInput([
      '>contig_alpha',
      'ACGT'.repeat(125),
      '>contig_beta',
      'TGCA'.repeat(100),
    ].join('\n'));
    registerPrototypeTransientInput(run.runId, parsed);

    render(<PrototypePredictionBrowser run={run} fixture={fixture} />);

    const panel = await screen.findByTestId('mock-prototype-browser-panel');
    expect(panel).toHaveAttribute('data-assembly', `prototype-${run.runId}`);
    expect(panel).toHaveAttribute('data-locus', 'contig_alpha:1-500');
    expect(panel).toHaveAttribute('data-reference-label', 'Submitted reference sequence (this tab only)');
    expect(panel).toHaveAttribute('data-reference-url', 'blob:prototype-1');
    expect(panel).toHaveAttribute('data-plus-url', 'blob:prototype-2');
    expect(panel).toHaveAttribute('data-minus-url', 'blob:prototype-3');
    expect(panel).toHaveAttribute('data-peaks-url', 'blob:prototype-4');
    expect(panel).toHaveAttribute('data-sharing', 'false');
    expect(screen.queryByRole('heading', { name: 'Browser tracks' })).not.toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('uses metadata-only illustrative fallback after transient input is absent and keeps only contig navigation', async () => {
    const user = userEvent.setup();
    const run = genomeRun('prototype-browser-fallback');
    const fixture = createPrototypeFixture(run);

    render(<PrototypePredictionBrowser run={run} fixture={fixture} />);

    const panel = await screen.findByTestId('mock-prototype-browser-panel');
    expect(panel).toHaveAttribute('data-reference-label', 'Illustrative reference sequence');
    expect(screen.queryByRole('heading', { name: 'Browser tracks' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Contig' }), 'contig_beta');
    await waitFor(() => expect(screen.getByTestId('mock-prototype-browser-panel')).toHaveAttribute('data-locus', 'contig_beta:1-400'));
    expect(screen.queryByRole('combobox', { name: 'Top called peak' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go to peak' })).not.toBeInTheDocument();
  });
});
