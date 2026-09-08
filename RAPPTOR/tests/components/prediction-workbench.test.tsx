// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PredictionWorkbench from '@/features/prediction/components/prediction-workbench';
import { PREDICTION_HISTORY_KEY, type PredictionHistoryEntry } from '@/features/prediction/history';
import type { JobSummary } from '@/features/prediction/live-result';

vi.mock('next/dynamic', () => ({
  default: () => ({ refName, accessToken }: { refName: string; accessToken: string }) => (
    <div data-testid="live-prediction-browser" data-reference={refName} data-access-token={accessToken}>
      Live genome browser
    </div>
  ),
}));

const saved: PredictionHistoryEntry = {
  jobId: '8242cc4cdaae4f07ab082dad6e3238fe',
  token: 'test-token',
  refName: 'chr1',
  status: 'succeeded',
  mode: 'genome_scan',
  submittedAt: '2026-08-29T09:25:25Z',
  label: 'recent-genome.fna',
  bases: 320,
  cutoff: 0.9,
  strandMode: 'both',
  strideBases: 1,
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function completedJob(mode: PredictionHistoryEntry['mode']) {
  return {
    job_id: saved.jobId,
    status: 'succeeded',
    model_version: 'candidate-github-93cf',
    submitted_at: saved.submittedAt,
    artifacts_expires_at: '2026-09-08T09:25:25Z',
    result: { artifacts: mode === 'predict' ? [
      { filename: 'scores.json', format: 'json', size_bytes: 200, sha256: 'scores' },
      { filename: 'scores.gff3', format: 'gff3', size_bytes: 200, sha256: 'score-gff' },
      { filename: 'peaks.gff3', format: 'gff3', size_bytes: 100, sha256: 'peaks' },
      { filename: 'summary.json', format: 'json', size_bytes: 100, sha256: 'summary' },
    ] : [
      { filename: 'scores.gff3', format: 'gff3', size_bytes: 10, sha256: 'gff' },
      { filename: 'scores.plus.bw', format: 'bigwig', size_bytes: 20, sha256: 'plus' },
      { filename: 'scores.minus.bw', format: 'bigwig', size_bytes: 20, sha256: 'minus' },
      { filename: 'input.fasta', format: 'fasta', size_bytes: 320, sha256: 'fasta' },
      { filename: 'input.fasta.fai', format: 'fai', size_bytes: 32, sha256: 'fai' },
      { filename: 'summary.json', format: 'json', size_bytes: 100, sha256: 'summary' },
    ] },
  };
}

function mockApi(mode: PredictionHistoryEntry['mode'], options: { sessionStatus?: number; missingArtifacts?: string[]; fai?: string; summary?: Partial<JobSummary> } = {}) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/session')) return new Response(null, { status: options.sessionStatus || 200 });
    if (String(input).endsWith('/artifacts/input.fasta.fai')) return new Response(options.fai || 'chr1\t320\t6\t60\t61\n');
    const job = completedJob(mode);
    job.result.artifacts = job.result.artifacts.filter((item) => !options.missingArtifacts?.includes(item.filename));
    return Response.json(String(input).endsWith('/artifacts/summary.json')
      ? mode === 'predict'
        ? { mode: 'predict', sequence_bases: 100, genome_context_bases: 4_641_652, window_count: 2, max_score: 0.3121, reverse_complementary: true, ...options.summary }
        : { mode: 'genome_scan', total_bases: 320, genome_context_bases: 320, contig_count: 1, window_count: 442, passing_window_count: 7, stride: 1, score_cutoff: .9, score_cutoff_operator: '>', cgr_source: 'complete_genome_assembly_fasta', reverse_complementary: true, model: { seq_length: 100, model_version: 'candidate-v1', model_asset_status: 'candidate_not_production', checkpoint_sha256: 'checkpoint-test' }, ...options.summary }
      : String(input).endsWith('/artifacts/scores.json')
        ? ['+', '-'].flatMap(strand => Array.from({ length: (options.summary?.sequence_bases ?? 100) - 99 }, (_, index) => ({
          strand, score: strand === '+' ? 0.3121 : 0.1842, window_start_0based: index,
          anchor_position_0based: strand === '+' ? index + 80 : (options.summary?.sequence_bases ?? 100) - index - 81,
        })))
        : job);
  }));
}

describe('live prediction result layout', () => {
  it('reports a legitimate zero peak result from the service on a shared task', async () => {
    mockApi('genome_scan', { summary: { peak_count: 0 } });
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', `/predict/task/${saved.jobId}#access=shared_access_token_1234567890abcdef`);
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByText('Called peaks')).toBeInTheDocument();
    expect(screen.getByText('Called peaks').parentElement).toHaveTextContent('0');
    expect(screen.queryByText('Exported windows')).not.toBeInTheDocument();
  });
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
    localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify([saved]));
    sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(saved));
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  });

  it('uses the same result design as the colleague prototype for a live genome scan', async () => {
    mockApi('genome_scan');
    render(<PredictionWorkbench initialJobId={saved.jobId} />);

    expect(await screen.findByRole('heading', { name: 'Prediction result' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Genome browser' })).toBeInTheDocument();
    expect(screen.getByTestId('live-prediction-browser')).toBeInTheDocument();
    expect(screen.getByTestId('live-prediction-browser')).toHaveAttribute('data-access-token', saved.token);
    expect(screen.getByText('442')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('Recent predictions')).not.toBeInTheDocument();
    expect(screen.queryByText('Prediction service ready')).not.toBeInTheDocument();
  });

  it('opens a capability link in a browser with no stored task history', async () => {
    mockApi('genome_scan');
    localStorage.clear();
    sessionStorage.clear();
    const sharedToken = 'shared_access_token_1234567890abcdef';
    window.location.hash = `access=${sharedToken}&ref=shared_chr`;

    render(<PredictionWorkbench initialJobId={saved.jobId} />);

    expect(await screen.findByRole('heading', { name: 'Genome browser' })).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/predictions/jobs/${saved.jobId}`, expect.objectContaining({
      headers: { 'X-Job-Token': sharedToken },
    })));
    expect(localStorage.getItem(PREDICTION_HISTORY_KEY)).toContain(sharedToken);
  });

  it('shows real focused strand scores instead of the old empty GFF3 panel', async () => {
    const focused = { ...saved, mode: 'predict' as const, label: 'Candidate sequence', bases: 4_641_752 };
    localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify([focused]));
    sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(focused));
    mockApi('predict', { summary: {
      peak_calling: { cutoff: .9, distance: 10, operator: '>' },
      smoothing: { method: 'gaussian', sigma: 1, mode: 'reflect' },
    } });

    render(<PredictionWorkbench initialJobId={saved.jobId} />);

    expect(await screen.findByRole('heading', { name: '100 bp result' })).toBeInTheDocument();
    expect(await screen.findByRole('meter', { name: 'Forward strand model score' })).toHaveAttribute('value', '0.3121');
    expect(screen.getByRole('meter', { name: 'Reverse strand model score' })).toHaveAttribute('value', '0.1842');
    expect(screen.queryByText(/did not request GFF3/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Genome browser' })).not.toBeInTheDocument();
    const result = screen.getByRole('region', { name: '100 bp result' });
    expect(within(result).getByRole('link', { name: 'Download scores (TSV)' })).toHaveAttribute('href', `/api/predictions/jobs/${saved.jobId}/artifacts/prediction-results.tsv`);
    expect(within(result).getByText(/^Available until/)).toHaveTextContent(new Date('2026-09-08T09:25:25Z').toLocaleString());
    expect(screen.queryByRole('region', { name: 'Download result' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /GFF3/ })).not.toBeInTheDocument();
    const info = screen.getByRole('region', { name: 'Prediction information' });
    expect(info).toHaveTextContent('Both strands');
    expect(info).toHaveTextContent('Cutoff: > 0.9');
    expect(within(result).getAllByText('Below threshold (≤ 0.9)')).toHaveLength(2);
    expect(info).not.toHaveTextContent(/Peak cutoff|Min\. distance|σ|Export cutoff/);
  });

  it('does not load artifacts when the artifact session rejects access', async () => {
    mockApi('genome_scan', { sessionStatus: 401 });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Task access is invalid or has expired');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/artifacts/'))).toBe(false);
    expect(screen.queryByTestId('live-prediction-browser')).not.toBeInTheDocument();
  });

  it('reports a missing summary instead of leaving the completed result blank', async () => {
    mockApi('genome_scan', { missingArtifacts: ['summary.json'] });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no summary.json artifact');
    expect(screen.queryByTestId('live-prediction-browser')).not.toBeInTheDocument();
  });

  it('requires the reverse track for a both-strand scan', async () => {
    mockApi('genome_scan', { missingArtifacts: ['scores.minus.bw'] });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('scores.minus.bw');
    expect(screen.queryByTestId('live-prediction-browser')).not.toBeInTheDocument();
  });

  it('recovers the reference name from the returned index for a shared task', async () => {
    localStorage.clear();
    sessionStorage.clear();
    window.location.hash = 'access=shared_access_token_1234567890abcdef';
    mockApi('genome_scan', { fai: 'NC_000913.3\t4641652\t73\t70\t71\n' });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByTestId('live-prediction-browser')).toHaveAttribute('data-reference', 'NC_000913.3');
  });

  it('does not use summary max_score as a substitute for missing strand scores', async () => {
    mockApi('predict', { missingArtifacts: ['scores.json'] });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no scores.json artifact');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download scores/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Download result' })).not.toBeInTheDocument();
  });

  it('refreshes service scan counters while a task is running', async () => {
    vi.useFakeTimers();
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({
      job_id: saved.jobId, status: 'running', progress: {
        stage: 'scanning', percent: 45, windows: ++polls === 1 ? 40 : 60, total_windows: 100,
        scan_percent: 40, contig: 'chr1', strand: '-',
      },
    })));
    await act(async () => { render(<PredictionWorkbench initialJobId={saved.jobId} />); });
    const scan = screen.getByRole('region', { name: 'Genome scan progress' });
    expect(scan).toHaveTextContent('40 / 100');
    expect(scan).toHaveTextContent('Reverse strand (−)');
    expect(within(scan).getByRole('progressbar')).toHaveAttribute('value', '40');
    expect(screen.queryByRole('region', { name: 'Download result' })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(polls).toBe(1);
    expect(scan).toHaveTextContent('40 / 100');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(polls).toBe(2);
    expect(scan).toHaveTextContent('60 / 100');
    expect(within(scan).getByRole('progressbar')).toHaveAttribute('value', '60');
  });

  it('passes actual queue information from the job endpoint into the waiting UI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      job_id: saved.jobId, status: 'queued', mode: 'genome_scan',
      queue: { ahead: 3, waiting: 4, running: 1, worker_ready: true },
    })));
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    const queue = await screen.findByRole('region', { name: 'Queue status' });
    await waitFor(() => expect(queue).toHaveTextContent('Busy'));
    expect(within(queue).getByText('Queued ahead').parentElement).toHaveTextContent('3');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('offers only GFF3 and a track ZIP, with three basic information fields', async () => {
    mockApi('genome_scan');
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    const downloads = await screen.findByRole('region', { name: 'Download result' });
    expect(within(downloads).getAllByRole('link')).toHaveLength(2);
    expect(within(downloads).getByRole('link', { name: /Prediction results GFF3/ })).toHaveAttribute('href', `/api/predictions/jobs/${saved.jobId}/artifacts/scores.gff3`);
    const tracks = within(downloads).getByRole('link', { name: /Model score tracks ZIP/ });
    expect(tracks).toHaveAttribute('href', `/api/predictions/jobs/${saved.jobId}/artifacts/model-score-tracks.zip`);
    expect(tracks).toHaveTextContent('Raw forward and reverse BigWig files in one folder');
    expect(screen.getByText('Exported windows')).toBeInTheDocument();
    expect(screen.queryByText('Run context')).not.toBeInTheDocument();
    expect(screen.queryByText(/private temporary access link/)).not.toBeInTheDocument();
    for (const removed of ['Additional files', 'Run details', 'input.fasta', 'input.fasta.fai', 'checkpoint-test', 'Genome context (CGR)', 'Stride', 'Window length']) expect(screen.queryByText(removed)).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Prediction information' })).getAllByRole('term')).toHaveLength(3);
    expect(screen.getByText('Model').closest('div')).toHaveTextContent('RAPPtor');
  });

  it('uses the completed parameters when local request history disagrees', async () => {
    mockApi('genome_scan', { summary: { score_cutoff: .75, stride: 20, reverse_complementary: false } });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByText('Cutoff: Model score > 0.75')).toBeInTheDocument();
    expect(screen.getByText('Prediction settings').closest('div')).toHaveTextContent('Forward strand only');
    expect(screen.queryByText(/configured threshold/)).not.toBeInTheDocument();
  });

  it('requires the returned both-strand track even when local history requested only forward', async () => {
    localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify([{ ...saved, strandMode: 'forward' }]));
    mockApi('genome_scan', { missingArtifacts: ['scores.minus.bw'], summary: { reverse_complementary: true } });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('scores.minus.bw');
  });

  it('does not infer a missing cutoff or strand setting from local history', async () => {
    mockApi('genome_scan', { summary: { score_cutoff: undefined, cgr_source: undefined, stride: undefined, reverse_complementary: undefined } });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    await screen.findByRole('heading', { name: 'Prediction information' });
    expect(screen.getByText('Prediction settings').closest('div')).toHaveTextContent('Strands not recorded');
    expect(screen.getByText('Cutoff: Not recorded')).toBeInTheDocument();
    expect(screen.queryByText('Same as input genome')).not.toBeInTheDocument();
  });

  it('distinguishes explicitly unfiltered results and shows actual parameters in a shared task', async () => {
    localStorage.clear(); sessionStorage.clear();
    window.location.hash = 'access=shared_access_token_1234567890abcdef';
    mockApi('genome_scan', { summary: { score_cutoff: null, cgr_source: 'separate_complete_genome_sequence' } });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    await screen.findByRole('heading', { name: 'Prediction information' });
    expect(screen.getByText('Prediction settings').closest('div')).toHaveTextContent('No export filtering');
  });

  it('shows a GFF3-unavailable explanation for older scans while preserving the track download', async () => {
    mockApi('genome_scan', { missingArtifacts: ['scores.gff3'] });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByText(/GFF3 is unavailable for this task/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Prediction results TSV/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Model score tracks ZIP/ })).toBeInTheDocument();
  });

  it('keeps the compact TSV download for older 100 bp tasks that have no GFF3', async () => {
    mockApi('predict', { missingArtifacts: ['scores.gff3', 'peaks.gff3'], summary: { cgr_source: 'reference_accession', reference_accession: 'GCF_000005845.2', genome_context_bases: null } });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    expect(await screen.findByRole('link', { name: 'Download scores (TSV)' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Prediction positions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Model score tracks' })).not.toBeInTheDocument();
    expect(screen.getByText('Prediction settings').closest('div')).not.toHaveTextContent('Export cutoff');
  });

  it('retains the full downloads and peak settings for a 101 bp result', async () => {
    mockApi('predict', { summary: {
      sequence_bases: 101, window_count: 4,
      peak_calling: { cutoff: .9, distance: 10, operator: '>' },
      smoothing: { method: 'gaussian', sigma: 1, mode: 'reflect' },
    } });
    render(<PredictionWorkbench initialJobId={saved.jobId} />);
    const downloads = await screen.findByRole('region', { name: 'Download result' });
    expect(within(downloads).getByRole('link', { name: /Prediction results TSV/ })).toBeInTheDocument();
    expect(within(downloads).getByRole('link', { name: /Predicted peaks GFF3/ })).toBeInTheDocument();
    expect(screen.getByText('Cutoff: > 0.9')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Short-sequence result' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download scores (TSV)' })).not.toBeInTheDocument();
  });
});
