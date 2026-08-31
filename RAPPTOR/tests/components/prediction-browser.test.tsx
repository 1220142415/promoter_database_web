// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PredictionBrowser from '@/features/prediction/components/prediction-browser';

vi.mock('@jbrowse/react-linear-genome-view', () => ({
  createViewState: vi.fn(() => ({ configured: true })),
}));

vi.mock('@/features/genome-browser/components/rapptor-jbrowse-linear-view', () => ({
  default: () => <div data-testid="mock-jbrowse" />,
}));

vi.mock('@/features/genome-browser/plugins/mirrored-score-plugin', () => ({
  default: { name: 'RapptorMirroredScorePlugin' },
}));

import { createViewState } from '@jbrowse/react-linear-genome-view';

describe('prediction browser tracks', () => {
  beforeEach(() => {
    vi.mocked(createViewState).mockClear();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:annotation') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
  });

  it('shows the reference sequence and adds a browser-local GFF3 track', async () => {
    const user = userEvent.setup();
    render(<PredictionBrowser jobId="job-1" refName="chr1" />);

    const initial = vi.mocked(createViewState).mock.calls[0][0] as unknown as {
      assembly: { sequence: { name: string; adapter: { type: string } } };
      tracks: ReadonlyArray<{ name: string; metadata?: { rapptorMirroredScore?: boolean } }>;
      defaultSession: { view: { tracks: ReadonlyArray<{ type: string }> } };
    };
    expect(initial.assembly.sequence).toMatchObject({ name: 'Reference sequence', adapter: { type: 'IndexedFastaAdapter' } });
    expect(initial.tracks.map((track) => track.name)).toEqual(['RAPPTOR raw scores (+ / - strands)']);
    expect(initial.tracks[0].metadata?.rapptorMirroredScore).toBe(true);
    expect(initial.defaultSession.view.tracks[0].type).toBe('ReferenceSequenceTrack');

    await user.upload(screen.getByLabelText('Add GFF3 annotation'), new File([
      '##gff-version 3\nchr1\ttest\tgene\t10\t40\t.\t+\t.\tID=gene1\n',
    ], 'genes.gff3', { type: 'text/plain' }));

    await waitFor(() => expect(createViewState).toHaveBeenCalledTimes(2));
    const annotated = vi.mocked(createViewState).mock.calls.at(-1)![0] as unknown as {
      tracks: ReadonlyArray<{ name: string; adapter: { type: string; gffLocation?: { uri: string } } }>;
      defaultSession: { view: { tracks: ReadonlyArray<{ type: string }> } };
    };
    expect(annotated.tracks[0]).toMatchObject({
      name: 'Uploaded annotation · genes.gff3',
      adapter: { type: 'Gff3Adapter', gffLocation: { uri: 'blob:annotation' } },
    });
    expect(annotated.defaultSession.view.tracks.map((track) => track.type)).toEqual([
      'ReferenceSequenceTrack',
      'FeatureTrack',
      'MultiQuantitativeTrack',
    ]);
    expect(screen.getByText('genes.gff3')).toBeInTheDocument();
  });
});
