// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';
import { REAL_PREDICTION_REFERENCE } from '@/features/prediction/reference-example';

// These component tests isolate transport/validation; real reference checks run separately.
vi.mock('@/features/prediction/reference-example', async (original) => ({
  ...await original<typeof import('@/features/prediction/reference-example')>(),
  validateReferenceExample: vi.fn(async (fasta: string) => ({ fasta, sequence: 'ACGT'.repeat(40), length: 160, sequenceId: 'NC_000913.2' })),
}));
const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
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
  refresh.mockClear();
  vi.unstubAllGlobals();
});

async function selectCgrCatalog(user: ReturnType<typeof userEvent.setup>) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      items: [{
        accession: 'GCF_000012685.1',
        organismName: 'Chlorobaculum tepidum TLS',
        genomeSizeBp: 2_154_946,
        contigCount: 1,
      }],
    }),
  })));
  await user.type(screen.getByRole('combobox', { name: 'Accession, organism, or strain' }), 'GCF_000012685.1');
  await user.click(screen.getByRole('button', { name: 'Search catalog' }));
  await waitFor(() => expect(screen.getByText('Genome context ready: Catalog genome.')).toBeInTheDocument());
}

describe('prototype prediction workbench', () => {
  it('keeps valid input while checking a configuration blocker and never claims it is ready to queue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`>NC_000913.2\n${'ACGT'.repeat(40)}\n`)));
    const user = userEvent.setup();
    const service = { available: true, modelVersion: 'candidate-github-93cf', supportsScoreCutoff: false, siteKey: '', submissionIssue: 'Email sign-in is not configured on this site. Prediction cannot be submitted yet.' };
    const { rerender } = render(<PrototypePredictionWorkbench localTest service={service} />);
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use 100 bp example' })).toBeEnabled());
    const original = (screen.getByLabelText('Raw DNA or FASTA') as HTMLTextAreaElement).value;
    expect(screen.getByRole('alert')).toHaveTextContent('Email sign-in is not configured');
    expect(screen.getByText('Prediction unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Ready to queue')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queue prediction' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Check availability again' }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Raw DNA or FASTA')).toHaveValue(original);
    expect(push).not.toHaveBeenCalled();
    rerender(<PrototypePredictionWorkbench localTest service={{ ...service, submissionIssue: undefined }} />);
    expect(screen.getByLabelText('Raw DNA or FASTA')).toHaveValue(original);
    expect(screen.getByRole('button', { name: 'Queue prediction' })).toBeEnabled();
  });

  it('does not download the complete reference for the 100 bp example', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench localTest service={{ available: true, modelVersion: 'candidate-github-93cf', supportsScoreCutoff: false, siteKey: '' }} />);
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    expect((screen.getByLabelText('Raw DNA or FASTA') as HTMLTextAreaElement).value).toContain('NC_000913.2:100001-100100');
    expect(screen.getByText('Only the accession is submitted; the prediction service reuses its cached CGR.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('does not offer an illustrative fallback when the real service is unavailable', () => {
    render(<PrototypePredictionWorkbench />);
    expect(screen.getByRole('button', { name: 'Queue prediction' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Preview illustrative result' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('not configured');
  });

  it('shows Turnstile only after the prediction inputs are ready', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`>NC_000913.2\n${'ACGT'.repeat(40)}\n`)));
    render(<PrototypePredictionWorkbench service={{ available: true, modelVersion: 'candidate-github-93cf', supportsScoreCutoff: false, siteKey: 'site-key' }} />);
    expect(screen.queryByLabelText('Human verification')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use 100 bp example' })).toBeEnabled());
    expect(await screen.findByLabelText('Human verification')).toBeInTheDocument();
    expect(screen.getByText('Complete this immediately before queuing the task.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queue prediction' })).toBeDisabled();
  });

  it('requires separate CGR context for the short example and stores v3 metadata only', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench preview />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByText('Prediction input required')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    expect(screen.getAllByText('100 bp scoring')).not.toHaveLength(0);
    expect(screen.queryByText('Top results')).not.toBeInTheDocument();
    expect(screen.queryByText('How was this analysis selected?')).not.toBeInTheDocument();
    expect(screen.queryByText('Parameters and summary')).not.toBeInTheDocument();
    const stride = screen.getByRole('spinbutton', { name: 'Stride' });
    expect(stride).toHaveValue(1);
    expect(stride).toBeEnabled();
    expect(screen.getByText(/A 100 bp input contains one window.*does not change this single score/)).toBeInTheDocument();
    await user.clear(stride);
    await user.type(stride, '37');
    expect(screen.getByText('Select a catalog genome or upload its FASTA in Step 2.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Preview illustrative result' });
    expect(submit).toBeEnabled();
    expect(screen.getByText('Genome context required')).toBeInTheDocument();
    expect(screen.getAllByText('Select a catalog genome or upload its FASTA.')[0]).toBeInTheDocument();
    await user.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('Genome context (CGR) is required');
    expect(push).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Use this genome' }));
    expect(screen.getByText('Genome context ready: Catalog genome.')).toBeInTheDocument();
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
    expect(JSON.parse(stored)).toMatchObject({ parameters: { strideBases: 37 }, modelSpec: { strideBases: 37 } });
  });

  it('loads the E. coli K-12 scan source but still requires separate CGR context', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench preview />);
    await user.click(screen.getByRole('button', { name: 'Use E. coli K-12 genome example' }));
    expect(screen.getAllByText('Sequence scan')).not.toHaveLength(0);
    expect(screen.getAllByText(/Escherichia coli str\. K-12/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Top results')).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Stride' })).toHaveValue(1);
    expect(screen.getByText(/Bases between consecutive 100 bp windows\. Enter an integer from 1 to 100\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Use this genome' }));
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
  });

  it('keeps paste and the compact FASTA upload control in one input card without source tabs or a primary catalog search', () => {
    render(<PrototypePredictionWorkbench preview />);
    expect(screen.getByLabelText('Raw DNA or FASTA')).toBeVisible();
    expect(screen.getByText('Try an example')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload FASTA' })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Accession, organism, or strain' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('uses the most recently provided input after a whole-genome example', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench preview />);
    await user.click(screen.getByRole('button', { name: 'Use E. coli K-12 genome example' }));
    expect(screen.getAllByText('Sequence scan')).not.toHaveLength(0);
    await selectCgrCatalog(user);
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
    await user.type(screen.getByLabelText('Raw DNA or FASTA'), 'ACGT'.repeat(25));
    expect(screen.getAllByText('100 bp scoring')).not.toHaveLength(0);
    expect(screen.getByRole('combobox', { name: 'Accession, organism, or strain' })).toHaveAttribute('id', 'prototype-context-catalog-search');
    expect(screen.getByText('Genome context required')).toBeInTheDocument();
  });

  it('requires separate CGR context after a primary FASTA upload', async () => {
    const user = userEvent.setup();
    const { container } = render(<PrototypePredictionWorkbench preview />);
    const primaryFile = new File([`>uploaded_scan\n${'ACGT'.repeat(40)}`], 'uploaded-scan.fna', { type: 'text/plain' });
    Object.defineProperty(primaryFile, 'text', { value: async () => `>uploaded_scan\n${'ACGT'.repeat(40)}` });
    const primaryInput = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[0];
    await user.upload(primaryInput, primaryFile);
    expect((await screen.findAllByText('Sequence scan')).length).toBeGreaterThan(0);
    expect(screen.getByText('Genome context required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove uploaded FASTA' })).toBeInTheDocument();

    const contextFile = new File([`>matching_context\n${'TGCA'.repeat(40)}`], 'matching-context.fna', { type: 'text/plain' });
    Object.defineProperty(contextFile, 'text', { value: async () => `>matching_context\n${'TGCA'.repeat(40)}` });
    const contextInput = container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    await user.upload(contextInput, contextFile);
    expect(await screen.findByText('Genome context ready: Matching genome FASTA.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Remove genome FASTA' }));
    expect(screen.getByRole('button', { name: 'Choose FASTA file' })).toBeInTheDocument();
    expect(screen.getByText('Genome context required')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove uploaded FASTA' }));
    expect(screen.getByRole('button', { name: 'Upload FASTA' })).toBeInTheDocument();
    expect(screen.getByText('Prediction input required')).toBeInTheDocument();
  });

  it('requires CGR context after a real paste event for a multi-record FASTA', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench preview />);
    const input = screen.getByLabelText('Raw DNA or FASTA');

    await user.click(input);
    await user.paste(`>pasted_contig\n${'ACGT'.repeat(40)}\n>second_contig\n${'TGCA'.repeat(35)}`);

    expect(screen.getAllByText('Sequence scan')).not.toHaveLength(0);
    expect(screen.queryByText('Top results')).not.toBeInTheDocument();
    expect(screen.getByText('Genome context required')).toBeInTheDocument();
    await selectCgrCatalog(user);
    expect(screen.getByRole('button', { name: 'Preview illustrative result' })).toBeEnabled();
  });

  it('keeps focused context catalog recovery without restoring a primary catalog block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench preview />);
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    await user.type(screen.getByRole('combobox', { name: 'Accession, organism, or strain' }), 'E. coli');
    await user.click(screen.getByRole('button', { name: 'Search catalog' }));
    expect(await screen.findByRole('button', { name: 'Retry search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload FASTA instead' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Help' })).not.toBeInTheDocument();
    expect((screen.getByLabelText('Raw DNA or FASTA') as HTMLTextAreaElement).value).toContain('CCGGTTGTACTTCATGAAC');
  });

  it('explains an invalid cutoff when input and CGR context are ready', async () => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench preview />);
    await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    await selectCgrCatalog(user);
    const cutoff = screen.getByRole('spinbutton', { name: /^Model threshold/ });
    await user.clear(cutoff);
    expect(screen.getAllByText('Enter a value from 0 to 1.').length).toBeGreaterThan(0);
    const submit = screen.getByRole('button', { name: 'Preview illustrative result' });
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent('Model threshold must be between 0 and 1');
    expect(push).not.toHaveBeenCalled();
  });

  it.each(['0', '101', '1.5'])('rejects invalid scan stride %s', async (value) => {
    const user = userEvent.setup();
    render(<PrototypePredictionWorkbench preview />);
    await user.click(screen.getByRole('button', { name: 'Use E. coli K-12 genome example' }));
    await user.click(screen.getByRole('button', { name: 'Use this genome' }));
    const stride = screen.getByRole('spinbutton', { name: 'Stride' });
    await user.clear(stride);
    await user.type(stride, value);
    expect(screen.getByText('Enter an integer from 1 to 100.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview illustrative result' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Stride must be an integer from 1 to 100');
    expect(push).not.toHaveBeenCalled();
  });

  it.each(['cached catalog', 'example accession', 'uploaded genome'] as const)('submits short input with a %s context', async (source) => {
    let jobRequest: Record<string, unknown> | null = null;
    let ticketRequest: Record<string, unknown> | null = null;
    const fasta = `>chromosome\n${'ACGT'.repeat(40)}\n`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/genomes?')) {
        return Response.json({ items: [{ accession: 'GCF_000012685.1', organismName: 'C. tepidum', genomeSizeBp: 2_154_946, contigCount: 1 }] });
      }
      if (url === '/api/prediction-tickets') {
        ticketRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ticket: 'local-ticket' }, { status: 201 });
      }
      if (url === '/api/predictions/jobs') {
        jobRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ job_id: 'a'.repeat(32), access_token: 'job-token' }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
    const user = userEvent.setup();
    const { container } = render(<PrototypePredictionWorkbench localTest service={{ available: true, modelVersion: 'candidate-github-93cf', supportsScoreCutoff: false, siteKey: '' }} />);

    if (source === 'example accession') {
      await user.click(screen.getByRole('button', { name: 'Use 100 bp example' }));
    } else {
      await user.type(screen.getByLabelText('Raw DNA or FASTA'), 'ACGT'.repeat(25));
      if (source === 'cached catalog') {
        await user.type(screen.getByRole('combobox', { name: 'Accession, organism, or strain' }), 'GCF_000012685.1');
        await user.click(screen.getByRole('button', { name: 'Search catalog' }));
      } else {
        const file = new File([fasta], 'genome.fna', { type: 'text/plain' });
        Object.defineProperty(file, 'text', { value: async () => fasta });
        await user.upload(container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], file);
      }
    }
    await waitFor(() => expect(screen.getByRole('button', { name: 'Queue prediction' })).toBeEnabled());
    const threshold = screen.getByRole('spinbutton', { name: /^Model threshold/ });
    expect(threshold).toBeEnabled();
    await user.clear(threshold);
    await user.type(threshold, '0.72');
    const stride = screen.getByRole('spinbutton', { name: 'Stride' });
    await user.clear(stride);
    await user.type(stride, '37');
    await user.click(screen.getByRole('button', { name: 'Queue prediction' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/predict/task/${'a'.repeat(32)}`));
    expect(jobRequest).toMatchObject({
      mode: 'predict',
      sequence: source === 'example accession' ? REAL_PREDICTION_REFERENCE.sample.sequence : 'ACGT'.repeat(25),
    });
    expect(jobRequest).not.toHaveProperty('genome_context');
    if (source !== 'uploaded genome') {
      expect(jobRequest).toHaveProperty('reference_accession', source === 'example accession' ? REAL_PREDICTION_REFERENCE.accession : 'GCF_000012685.1');
      expect(jobRequest).not.toHaveProperty('fasta');
      expect(fetchMock.mock.calls.every(([input]) => /^\/api\/(genomes\?|prediction-tickets$|predictions\/jobs$)/.test(String(input)))).toBe(true);
    } else {
      expect(jobRequest).toHaveProperty('fasta', fasta.trimEnd());
      expect(jobRequest).not.toHaveProperty('reference_accession');
    }
    expect(ticketRequest).toMatchObject({ bases: source === 'uploaded genome' ? 260 : 100, mode: 'predict' });
    expect(jobRequest).not.toHaveProperty('score_cutoff');
    expect(jobRequest).not.toHaveProperty('stride');
    expect(JSON.parse(sessionStorage.getItem('rapptor-prediction-job') || 'null')).toMatchObject({ cutoff: .72, strideBases: 37 });
  });

  it('submits every pasted sequence over 100 bp through genome_scan for browser artifacts', async () => {
    let jobRequest: Record<string, unknown> | null = null;
    let ticketRequest: Record<string, unknown> | null = null;
    const scanSequence = `${'ACGT'.repeat(25)}A`;
    const contextFasta = `>context\n${'TGCA'.repeat(40)}\n`;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/prediction-tickets') {
        ticketRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ticket: 'local-ticket' }, { status: 201 });
      }
      if (String(input) === '/api/predictions/jobs') {
        jobRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ job_id: 'd'.repeat(32), access_token: 'job-token' }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
    const user = userEvent.setup();
    const { container } = render(<PrototypePredictionWorkbench localTest service={{ available: true, modelVersion: 'candidate-github-93cf', supportsScoreCutoff: true, supportsPeakCalling: true, gff3RequiresStride1: true, siteKey: '' }} />);
    fireEvent.change(screen.getByLabelText('Raw DNA or FASTA'), { target: { value: scanSequence } });
    const contextFile = new File([contextFasta], 'context.fna', { type: 'text/plain' });
    Object.defineProperty(contextFile, 'text', { value: async () => contextFasta });
    await user.upload(container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], contextFile);
    const stride = screen.getByRole('spinbutton', { name: 'Stride' });
    await user.clear(stride);
    await user.type(stride, '37');
    const cutoff = screen.getByRole('spinbutton', { name: /^Export cutoff/ });
    await user.clear(cutoff);
    await user.type(cutoff, '0.81');
    await user.click(screen.getByRole('button', { name: 'Queue prediction' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/predict/task/${'d'.repeat(32)}`));
    expect(jobRequest).toMatchObject({
      mode: 'genome_scan', fasta: `>inline_sequence\n${scanSequence}`,
      genome_context: 'TGCA'.repeat(40), stride: 37,
      score_cutoff: .81, output_formats: ['bigwig', 'parquet', 'json'],
    });
    expect(jobRequest).not.toHaveProperty('sequence');
    expect(ticketRequest).toMatchObject({ mode: 'genome_scan', bases: 261 });
  });

  it.each([
    { label: 'unsupported peaks', supportsPeaks: false, requiresStride1: true, stride: 37, peaks: false },
    { label: 'dense peaks', supportsPeaks: true, requiresStride1: true, stride: 1, peaks: true },
    { label: 'sampled peaks', supportsPeaks: true, requiresStride1: false, stride: 37, peaks: true },
  ])('reuses the CGR input and submits the correct scan outputs ($label)', async ({ supportsPeaks, requiresStride1, stride: selectedStride, peaks }) => {
    let jobRequest: Record<string, unknown> | null = null;
    let ticketRequest: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/prediction-reference/')) {
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
    render(<PrototypePredictionWorkbench localTest service={{ available: true, modelVersion: "candidate-github-93cf", supportsScoreCutoff: supportsPeaks, supportsPeakCalling: supportsPeaks, gff3RequiresStride1: requiresStride1, siteKey: "" }} />);

    await user.click(screen.getByRole('button', { name: 'Use E. coli K-12 genome example' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Queue prediction' })).toBeEnabled());
    const stride = screen.getByRole('spinbutton', { name: 'Stride' });
    await user.clear(stride);
    await user.type(stride, String(selectedStride));
    const cutoff = screen.getByRole('spinbutton', { name: peaks ? /^Peak cutoff/ : /^Export cutoff/ });
    if (peaks) {
      expect(cutoff).toBeEnabled();
      expect(screen.getByText(`Local maxima above this cutoff are called as peaks at ${selectedStride} bp sampling resolution.`)).toBeInTheDocument();
      await user.clear(cutoff);
      await user.type(cutoff, '0.73');
    } else {
      expect(cutoff).toBeDisabled();
    }
    await user.selectOptions(screen.getByRole('combobox', { name: /^Strands/ }), 'forward');
    await user.click(screen.getByRole('button', { name: 'Queue prediction' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(`/predict/task/${'b'.repeat(32)}`));
    expect(jobRequest).toMatchObject({
      mode: 'genome_scan',
      stride: selectedStride,
      reverse_complementary: false,
      output_formats: peaks ? ['bigwig', 'gff3'] : ['bigwig', 'parquet'],
    });
    expect(jobRequest).not.toHaveProperty('genome_context');
    if (peaks) expect(jobRequest).toHaveProperty('score_cutoff', .73);
    else expect(jobRequest).not.toHaveProperty('score_cutoff');
    expect(ticketRequest).toMatchObject({ bases: 160, mode: 'genome_scan' });
    expect(ticketRequest).not.toHaveProperty('turnstileToken');
    if (!peaks) expect(JSON.parse(sessionStorage.getItem('rapptor-prediction-job') || 'null')).not.toHaveProperty('cutoff');
    expect(screen.getByText('本地真实预测测试')).toBeInTheDocument();
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
    const { container } = render(<PrototypePredictionWorkbench localTest service={{ available: true, modelVersion: "candidate-github-93cf", supportsScoreCutoff: false, siteKey: "" }} />);
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
    expect(ticketRequest).toMatchObject({ bases: 320, mode: 'genome_scan' });
  });
});
