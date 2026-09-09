import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/email-system/access-mode', () => ({ predictionAccessMode: () => 'ip' }));
vi.mock('@/features/usage/store', () => ({ usageDatabase: vi.fn(() => ({})) }));
vi.mock('@/features/prediction/tickets', async (original) => ({
  ...await original<typeof import('@/features/prediction/tickets')>(),
  claimPredictionReferenceDownload: vi.fn(async () => true),
  readPredictionTicketIssueSettings: () => ({ modelVersion: 'model-test' }),
}));
vi.mock('@/features/prediction/ncbi-reference', async (original) => ({
  ...await original<typeof import('@/features/prediction/ncbi-reference')>(),
  downloadNcbiFasta: vi.fn(async () => '>reference\nACGT\n'),
}));

import { POST } from '@/app/api/predictions/jobs/route';
import { claimPredictionReferenceDownload } from '@/features/prediction/tickets';
import { downloadNcbiFasta } from '@/features/prediction/ncbi-reference';
import { usageDatabase } from '@/features/usage/store';

const payload = { mode: 'predict', sequence: 'A'.repeat(100), ncbi_accession: 'GCF_000005845.2', complete_genome: true, reverse_complementary: true };
function request(body: unknown = payload) {
  return new Request('https://example.test/api/predictions/jobs', { method: 'POST', headers: { Authorization: `Ticket ${'t'.repeat(43)}` }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://docker.test');
  vi.mocked(claimPredictionReferenceDownload).mockResolvedValue(true);
  vi.mocked(downloadNcbiFasta).mockResolvedValue('>reference\nACGT\n');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ job_id: 'a'.repeat(32), access_token: 'token' }, { status: 202 })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Worker NCBI to Docker FASTA bridge', () => {
  it('claims ticket before download and forwards only the existing Docker fields', async () => {
    expect((await POST(request())).status).toBe(202);
    expect(claimPredictionReferenceDownload).toHaveBeenCalledWith({}, 't'.repeat(43), 'model-test');
    expect(vi.mocked(claimPredictionReferenceDownload).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(downloadNcbiFasta).mock.invocationCallOrder[0]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://docker.test/v1/jobs');
    expect(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer))).toEqual({ mode: 'predict', sequence: payload.sequence, complete_genome: true, reverse_complementary: true, fasta: '>reference\nACGT\n' });
    expect(init?.headers).toMatchObject({ Authorization: `Ticket ${'t'.repeat(43)}` });
  });

  it('never downloads when ticket claim fails (expired, replayed, invalid)', async () => {
    vi.mocked(claimPredictionReferenceDownload).mockResolvedValue(false);
    expect((await POST(request())).status).toBe(401);
    expect(downloadNcbiFasta).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { fasta: '>x\nACGT' }, { genome_context: 'ACGT' }, { reference_accession: 'GCF_000005845.1' },
    { reference_source: { url: 'https://evil.test' } }, { ncbi_accession: 'https://evil.test' },
    { mode: 'genome_scan' }, { sequence: 'A'.repeat(101) }, { complete_genome: false }, { reverse_complementary: 'true' },
  ])('rejects conflicting or invalid fields %j before download', async (extra) => {
    expect((await POST(request({ ...payload, ...extra }))).status).toBe(400);
    expect(downloadNcbiFasta).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed if D1 is unavailable', async () => {
    vi.mocked(usageDatabase).mockReturnValueOnce(null);
    expect((await POST(request())).status).toBe(503);
    expect(downloadNcbiFasta).not.toHaveBeenCalled();
  });

  it('reports missing migration or ticket configuration as authorization unavailable, not an NCBI outage', async () => {
    vi.mocked(claimPredictionReferenceDownload).mockRejectedValueOnce(new Error('missing migration'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAVAILABLE', message: expect.stringContaining('authorization is unavailable') } });
    expect(downloadNcbiFasta).not.toHaveBeenCalled();
  });

  it('rejects the expanded JSON body before contacting Docker', async () => {
    vi.stubEnv('RAPPTOR_MAX_REQUEST_BYTES', '400');
    vi.mocked(downloadNcbiFasta).mockResolvedValue(`>reference\n${'A'.repeat(400)}`);
    expect((await POST(request())).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the ordinary catalog submission', async () => {
    const ordinary = { mode: 'predict', sequence: payload.sequence, reference_accession: 'GCF_000005845.1', complete_genome: true };
    expect((await POST(request(ordinary))).status).toBe(202);
    expect(downloadNcbiFasta).not.toHaveBeenCalled();
    expect(claimPredictionReferenceDownload).not.toHaveBeenCalled();
  });

  it.each([null, [], 'invalid'])('rejects non-object JSON %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
  });
});
