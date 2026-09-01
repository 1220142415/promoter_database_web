// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/features/prediction/client', () => ({
  predictionApi: vi.fn(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error('Prediction request failed.');
    return response.json();
  }),
  sha256Text: vi.fn(async () => 'a'.repeat(64)),
  sha256File: vi.fn(async () => 'b'.repeat(64)),
}));

afterEach(() => {
  sessionStorage.clear();
  push.mockClear();
  vi.unstubAllGlobals();
});

describe('prototype prediction workbench', () => {
  it('infers the focused workflow and queues it through the Docker prediction API', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/remote-data/')) return new Response(`>context\n${'A'.repeat(200)}\n`, { headers: { 'Content-Type': 'text/plain' } });
      if (url === '/api/prediction-tickets') return Response.json({ ticket: 'local-ticket' }, { status: 201 });
      if (url === '/api/predictions/jobs') return Response.json({ job_id: 'a'.repeat(32), access_token: 'job-token' }, { status: 202 });
      throw new Error(`Unexpected request: ${url} ${init?.method || 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench localTest />);
    expect(screen.queryByRole('tab', { name: /Candidate region|Whole genome/ })).not.toBeInTheDocument();
    expect(screen.getByText('Docker prediction service')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Example input' }), 'focused');
    expect(screen.getAllByText('Focused candidate')).not.toHaveLength(0);
    expect(screen.queryByText('Top results')).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Queue prediction' });
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/predict/task/${'a'.repeat(32)}`));
    expect(fetchMock).toHaveBeenCalledWith('/api/prediction-tickets', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/predictions/jobs', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Ticket local-ticket' },
    }));
    expect(sessionStorage.getItem('rapptor-prediction-job')).toContain('"token":"job-token"');
  });

  it('infers scan from multi-contig input and reports skipped short contigs', async () => {
    let jobRequest: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/prediction-tickets') return Response.json({ ticket: 'local-ticket' }, { status: 201 });
      if (url === '/api/predictions/jobs') {
        jobRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ job_id: 'b'.repeat(32), access_token: 'job-token' }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench localTest />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Example input' }), 'contig');
    expect(screen.getAllByText('Genome scan')).not.toHaveLength(0);
    expect(screen.getByText(/1 short contig skipped/)).toBeInTheDocument();
    expect(screen.queryByText('Top results')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Queue prediction' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/predict/task/${'b'.repeat(32)}`));
    expect(jobRequest).toMatchObject({ mode: 'genome_scan', stride: 1, reverse_complementary: true, output_formats: ['bigwig', 'gff3'] });
  });

  it('switches the unified input sources with keyboard tabs', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench localTest />);
    screen.getByRole('tab', { name: 'Paste sequence' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Upload FASTA' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Genome catalog' })).toHaveAttribute('aria-selected', 'true');
  });

  it('preserves the workflow and offers recovery actions when catalog search fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench localTest />);
    await user.click(screen.getByRole('tab', { name: 'Genome catalog' }));
    await user.type(screen.getByRole('combobox', { name: 'Accession, organism, or strain' }), 'E. coli');
    await user.click(screen.getByRole('button', { name: 'Search catalog' }));
    expect(await screen.findByRole('button', { name: 'Retry search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload FASTA instead' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Help' })).not.toBeInTheDocument();
  });

  it('disables submission when the deployment is not configured for direct prediction', async () => {
    render(<PrototypePredictionWorkbench />);
    expect(screen.getByText('Prediction service unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queue prediction' })).toBeDisabled();
  });
});
