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

async function selectCgrCatalog(user: ReturnType<typeof userEvent.setup>) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      items: [{
        accession: 'GCF_000005845.2',
        organismName: 'Escherichia coli str. K-12 substr. MG1655',
        genomeSizeBp: 4_641_652,
        contigCount: 1,
      }],
    }),
  })));
  await user.type(screen.getByRole('combobox', { name: 'Accession, organism, or strain' }), 'GCF_000005845.2');
  await waitFor(() => expect(screen.getByText('CGR context ready: Catalog genome.')).toBeInTheDocument());
}

describe('prototype prediction workbench', () => {
  it('requires separate CGR context for the short example and stores v3 metadata only', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByText('Prediction input required')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    expect(screen.getAllByText('Focused 100 bp window')).not.toHaveLength(0);
    expect(screen.queryByText('Top results')).not.toBeInTheDocument();
    expect(screen.queryByText('How was this analysis selected?')).not.toBeInTheDocument();
    expect(screen.queryByText('Parameters and summary')).not.toBeInTheDocument();
    const stride = screen.getByRole('combobox', { name: 'Step' });
    expect(stride).toHaveValue('1');
    expect(screen.getByText('A 100 bp input contains one window.')).toBeInTheDocument();
    await user.selectOptions(stride, '10');
    expect(screen.getByText('Select a catalog genome or upload a genome FASTA for CGR.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Preview illustrative result' });
    expect(submit).toBeEnabled();
    expect(screen.getByText('Genome context required')).toBeInTheDocument();
    expect(screen.getByText(/Complete Step 2 by selecting a catalog genome/)).toBeInTheDocument();
    await user.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('Genome context for CGR is required');
    expect(push).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Use this genome for CGR' }));
    expect(screen.getByText('CGR context ready: Catalog genome.')).toBeInTheDocument();
    expect(submit).toBeEnabled();
    expect(submit).toHaveTextContent('Preview illustrative result');
    expect(screen.getByText('Ready to preview')).toBeInTheDocument();
    await user.click(submit);
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/predict\/demo\/prototype_/)));
    const stored = sessionStorage.getItem(sessionStorage.key(0) || '') || '';
    expect(stored).toContain('"schemaVersion":3');
    expect(stored).toContain('"kind":"candidate"');
    expect(stored).not.toContain('"sequence"');
    expect(stored).not.toContain('focused_candidate_100bp');
    expect(stored).not.toContain('"topK"');
    expect(JSON.parse(stored)).toMatchObject({ parameters: { strideBases: 10 }, modelSpec: { strideBases: 10 } });
  });

  it('loads the E. coli K-12 scan source but still requires separate CGR context', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    await user.click(screen.getByRole('button', { name: 'Use E. coli K-12 genome example' }));
    expect(screen.getAllByText('Sequence / contig scan')).not.toHaveLength(0);
    expect(screen.getAllByText(/Escherichia coli str\. K-12/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Top results')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Step' })).toHaveValue('1');
    expect(screen.getByText('Bases between consecutive 100 nt windows.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Use this genome for CGR' }));
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
  });

  it('keeps paste and the compact FASTA upload control in one input card without source tabs or a primary catalog search', () => {
    render(<PrototypePredictionWorkbench />);
    expect(screen.getByLabelText('Raw DNA or FASTA')).toBeVisible();
    expect(screen.getByText('Try an example')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload FASTA' })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Accession, organism, or strain' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('uses the most recently provided input after a whole-genome example', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    await user.click(screen.getByRole('button', { name: 'Use E. coli K-12 genome example' }));
    expect(screen.getAllByText('Sequence / contig scan')).not.toHaveLength(0);
    await selectCgrCatalog(user);
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
    await user.type(screen.getByLabelText('Raw DNA or FASTA'), 'ACGT'.repeat(25));
    expect(screen.getAllByText('Focused 100 bp window')).not.toHaveLength(0);
    expect(screen.getByRole('combobox', { name: 'Accession, organism, or strain' })).toHaveAttribute('id', 'prototype-context-catalog-search');
    expect(screen.getByText('Genome context required')).toBeInTheDocument();
  });

  it('requires separate CGR context after a primary FASTA upload', async () => {
    const user = userEvent.setup();
    const { container } = render(<PrototypePredictionWorkbench />);
    const primaryFile = new File([`>uploaded_scan\n${'ACGT'.repeat(40)}`], 'uploaded-scan.fna', { type: 'text/plain' });
    Object.defineProperty(primaryFile, 'text', { value: async () => `>uploaded_scan\n${'ACGT'.repeat(40)}` });
    const primaryInput = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0];
    await user.upload(primaryInput, primaryFile);
    expect((await screen.findAllByText('Sequence / contig scan')).length).toBeGreaterThan(0);
    expect(screen.getByText('Genome context required')).toBeInTheDocument();

    const contextFile = new File([`>matching_context\n${'TGCA'.repeat(40)}`], 'matching-context.fna', { type: 'text/plain' });
    Object.defineProperty(contextFile, 'text', { value: async () => `>matching_context\n${'TGCA'.repeat(40)}` });
    const contextInput = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    await user.upload(contextInput, contextFile);
    expect(await screen.findByText('CGR context ready: Matching genome FASTA.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
  });

  it('requires CGR context after a real paste event for a multi-record FASTA', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    const input = screen.getByLabelText('Raw DNA or FASTA');

    await user.click(input);
    await user.paste(`>pasted_contig\n${'ACGT'.repeat(40)}\n>second_contig\n${'TGCA'.repeat(35)}`);

    expect(screen.getAllByText('Sequence / contig scan')).not.toHaveLength(0);
    expect(screen.queryByText('Top results')).not.toBeInTheDocument();
    expect(screen.getByText('Genome context required')).toBeInTheDocument();
    await selectCgrCatalog(user);
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
  });

  it('keeps focused context catalog recovery without restoring a primary catalog block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    await user.type(screen.getByRole('combobox', { name: 'Accession, organism, or strain' }), 'E. coli');
    await user.click(screen.getByRole('button', { name: 'Search catalog' }));
    expect(await screen.findByRole('button', { name: 'Retry search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload FASTA instead' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Help' })).not.toBeInTheDocument();
    expect((screen.getByLabelText('Raw DNA or FASTA') as HTMLTextAreaElement).value).toContain('ACGT');
  });

  it('explains an invalid cutoff when input and CGR context are ready', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench />);
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    await selectCgrCatalog(user);
    const cutoff = screen.getByRole('spinbutton', { name: /^Score cutoff/ });
    await user.clear(cutoff);
    expect(screen.getByText('Enter a value from 0 to 1.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Preview illustrative result' });
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a score cutoff from 0 to 1');
    expect(push).not.toHaveBeenCalled();
  });

  it('reuses a matching catalog scan source for CGR without duplicating bases or request data', async () => {
    let jobRequest: Record<string, unknown> | null = null;
    let ticketRequest: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/remote-data/')) {
        return new Response(`>chromosome\n${'ACGT'.repeat(40)}\n`, { headers: { 'Content-Type': 'text/plain' } });
      }
      if (url === '/api/prediction-tickets') {
        ticketRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ticket: 'local-ticket' }, { status: 201 });
      }
      if (url === '/api/predictions/jobs') {
        jobRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ job_id: 'b'.repeat(32), access_token: 'job-token' }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench localTest />);

    await user.click(screen.getByRole('button', { name: 'Use E. coli K-12 genome example' }));
    await user.click(screen.getByRole('button', { name: 'Use this genome for CGR' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Step' }), '10');
    await user.clear(screen.getByRole('spinbutton', { name: /^Score cutoff/ }));
    await user.type(screen.getByRole('spinbutton', { name: /^Score cutoff/ }), '0.8');
    await user.selectOptions(screen.getByRole('combobox', { name: /^Strands/ }), 'forward');
    await user.click(screen.getByRole('button', { name: 'Queue prediction' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/predict/task/${'b'.repeat(32)}`));
    expect(jobRequest).toMatchObject({
      mode: 'genome_scan',
      stride: 10,
      score_cutoff: 0.8,
      reverse_complementary: false,
      output_formats: ['bigwig', 'gff3'],
    });
    expect(jobRequest).not.toHaveProperty('genome_context');
    expect(ticketRequest).toMatchObject({ bases: 160 });
    expect(sessionStorage.getItem('rapptor-prediction-job')).toContain('"token":"job-token"');
  });

  it('keeps a distinct uploaded CGR genome when it differs from the scan source', async () => {
    let jobRequest: Record<string, unknown> | null = null;
    let ticketRequest: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/prediction-tickets') {
        ticketRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ticket: 'local-ticket' }, { status: 201 });
      }
      if (url === '/api/predictions/jobs') {
        jobRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ job_id: 'c'.repeat(32), access_token: 'job-token' }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
    const user = userEvent.setup();
    const { container } = render(<PrototypePredictionWorkbench localTest />);
    const scanText = `>scan\n${'ACGT'.repeat(40)}\n`;
    const contextText = `>context\n${'TGCA'.repeat(40)}\n`;
    const scanFile = new File([scanText], 'scan.fna', { type: 'text/plain' });
    const contextFile = new File([contextText], 'context.fna', { type: 'text/plain' });
    Object.defineProperty(scanFile, 'text', { value: async () => scanText });
    Object.defineProperty(contextFile, 'text', { value: async () => contextText });

    await user.upload(container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0], scanFile);
    await user.upload(container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], contextFile);
    await user.click(screen.getByRole('button', { name: 'Queue prediction' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/predict/task/${'c'.repeat(32)}`));
    expect(jobRequest).toMatchObject({ mode: 'genome_scan', genome_context: 'TGCA'.repeat(40) });
    expect(ticketRequest).toMatchObject({ bases: 320 });
  });
});
