import { describe, expect, it, vi } from 'vitest';
import { acquireLiveTicket, fetchLiveRead, validateSummary } from '../../scripts/prediction/run-live.mjs';

describe('live acceptance summary contract (offline validation only)', () => {
  const model = { model_version: 'candidate-github-93cf', checkpoint_sha256: '93cfcbaf74e3a693dfd12406d11ad79fef0933b90913db83c230a3f3a99582ad' };
  const genome = { model, mode: 'genome_scan', reverse_complementary: true, total_bases: 4_639_675, contig_count: 1, stride: 1, window_count: 9_279_152 };
  it('requires all 9,279,152 windows for a complete genome', () => {
    expect(() => validateSummary(genome, 'genome')).not.toThrow();
    expect(() => validateSummary({ ...genome, window_count: 928_310 }, 'genome')).toThrow('window');
  });
  it('rejects another model, one strand, or a sparse scan', () => {
    expect(() => validateSummary({ ...genome, model: { ...model, model_version: 'production' } }, 'genome')).toThrow('identity');
    expect(() => validateSummary({ ...genome, reverse_complementary: false }, 'genome')).toThrow('strand');
    expect(() => validateSummary({ ...genome, stride: 10 }, 'genome')).toThrow('stride');
  });
  it('requires the entire genome as the short-sequence CGR background', () => {
    const candidate = { model, mode: 'predict', reverse_complementary: true, sequence_bases: 100, genome_context_bases: 4_639_675, window_count: 2 };
    expect(() => validateSummary(candidate, 'candidate')).not.toThrow();
    expect(() => validateSummary({ ...candidate, genome_context_bases: 100 }, 'candidate')).toThrow('lengths');
  });
  it('does not accept the old service single-strand candidate result as a successful two-strand test', () => {
    const returned = { model, mode: 'predict', sequence_bases: 100, genome_context_bases: 4_639_675, window_count: 1 };
    expect(() => validateSummary(returned, 'candidate')).toThrow('window');
    // A failed candidate contract does not change the genome acceptance criteria.
    expect(() => validateSummary(genome, 'genome')).not.toThrow();
  });
});

describe('automatic live ticket acquisition (offline contract only)', () => {
  const input = { mode: 'predict', modelVersion: 'candidate-github-93cf', bases: 4_639_775 };
  it('gets a fresh ticket per call from the local app without needing a secret in the runner', async () => {
    const request = vi.fn(async () => Response.json({ ticket: 'a'.repeat(43), modelVersion: input.modelVersion, maxBases: input.bases, expiresAt: new Date(Date.now() + 120_000).toISOString() }));
    await acquireLiveTicket('http://127.0.0.1:3000', input, request);
    await acquireLiveTicket('http://127.0.0.1:3000', input, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:3000/api/prediction-tickets', expect.objectContaining({ headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' }, body: JSON.stringify(input) }));
  });
  it('reports a blocked issuer and refuses nonlocal destinations', async () => {
    await expect(acquireLiveTicket('http://127.0.0.1:3000', input, async () => Response.json({}, { status: 503 }))).rejects.toThrow('No task was submitted');
    const request = vi.fn();
    await expect(acquireLiveTicket('https://remote.example.test', input, request)).rejects.toThrow('loopback');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('read-only live polling recovery', () => {
  it('recovers from a network disconnect and gateway error without submitting another task', async () => {
    const request = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ status: 'running' }));
    const wait = vi.fn();
    expect(await (await fetchLiveRead('https://service.example.test/v1/jobs/existing', {}, request, wait)).json()).toEqual({ status: 'running' });
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
  it('does not retry invalid tokens or task submissions', async () => {
    const request = vi.fn(async () => new Response(null, { status: 401 }));
    const wait = vi.fn();
    expect((await fetchLiveRead('https://service.example.test/v1/jobs/existing', {}, request, wait)).status).toBe(401);
    await expect(fetchLiveRead('https://service.example.test/v1/jobs', { method: 'POST' }, request, wait)).rejects.toThrow('Only read');
    expect(request).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
});
