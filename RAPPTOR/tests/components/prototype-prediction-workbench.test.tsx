// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/features/prediction/client', () => ({
  sha256Text: vi.fn(async () => 'a'.repeat(64)),
  sha256File: vi.fn(async () => 'b'.repeat(64)),
}));

afterEach(() => {
  sessionStorage.clear();
  push.mockClear();
  vi.unstubAllGlobals();
});

describe('prototype prediction workbench', () => {
  it('infers the focused workflow from the 100 bp example and stores v2 metadata only', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    expect(screen.queryByRole('tab', { name: /Candidate region|Whole genome/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    expect(screen.getAllByText('Focused candidate')).not.toHaveLength(0);
    expect(screen.queryByText('Top results')).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Preview illustrative result' });
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/predict\/demo\/prototype_/)));
    const stored = sessionStorage.getItem(sessionStorage.key(0) || '') || '';
    expect(stored).toContain('"schemaVersion":2');
    expect(stored).toContain('"kind":"candidate"');
    expect(stored).not.toContain('"sequence"');
    expect(stored).not.toContain('focused_candidate_100bp');
    expect(stored).not.toContain('"topK"');
  });

  it('infers scan from multi-contig input, reports skipped short contigs, and shows topK', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    await user.click(screen.getByRole('button', { name: 'Use contig example' }));
    expect(screen.getAllByText('Genome scan')).not.toHaveLength(0);
    expect(screen.getByText(/1 short contig skipped/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Top results/ })).toHaveValue('10');
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
  });

  it('switches the unified input sources with keyboard tabs', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    screen.getByRole('tab', { name: 'Paste sequence' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Upload FASTA' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Genome catalog' })).toHaveAttribute('aria-selected', 'true');
  });

  it('preserves the workflow and offers recovery actions when catalog search fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    await user.click(screen.getByRole('tab', { name: 'Genome catalog' }));
    await user.type(screen.getByRole('combobox', { name: 'Accession, organism, or strain' }), 'E. coli');
    await user.click(screen.getByRole('button', { name: 'Search catalog' }));
    expect(await screen.findByRole('button', { name: 'Retry search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload FASTA instead' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Help' })).toHaveAttribute('href', '/help/prediction#troubleshooting');
  });

  it('disables submission when the cutoff is empty', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    const cutoff = screen.getByRole('spinbutton', { name: /^Score cutoff/ });
    await user.clear(cutoff);
    expect(screen.getByText('Enter a value from 0 to 1.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeDisabled();
  });
});
