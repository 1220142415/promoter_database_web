import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/email-system/access-mode', () => ({ predictionAccessMode: () => 'ip' }));
vi.mock('@/features/usage/store', () => ({ usageDatabase: vi.fn(() => ({})) }));
vi.mock('@/features/prediction/tickets', async (original) => ({
  ...await original<typeof import('@/features/prediction/tickets')>(),
  claimPredictionReferenceDownload: vi.fn(async () => true),
  readPredictionTicketIssueSettings: () => ({ modelVersion: 'model-test' }),
}));
vi.mock('@/features/prediction/reference-cache', () => ({ preparePredictionReference: vi.fn(async () => undefined) }));

import { POST } from '@/app/api/predictions/jobs/route';
import { claimPredictionReferenceDownload } from '@/features/prediction/tickets';
import { preparePredictionReference } from '@/features/prediction/reference-cache';
import { NcbiReferenceError } from '@/features/prediction/ncbi-reference';
import { usageDatabase } from '@/features/usage/store';

const payload = { mode: 'predict', sequence: 'A'.repeat(100), ncbi_accession: 'GCF_000005845.2', complete_genome: true, reverse_complementary: true };
function request(body: unknown = payload) {
  return new Request('https://example.test/api/predictions/jobs', { method: 'POST', headers: { Authorization: `Ticket ${'t'.repeat(43)}` }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://docker.test');
  vi.mocked(claimPredictionReferenceDownload).mockResolvedValue(true);
  vi.mocked(preparePredictionReference).mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ job_id: 'a'.repeat(32), access_token: 'token' }, { status: 202 })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Worker NCBI to Docker FASTA bridge', () => {
  it('claims ticket before download and forwards only the existing Docker fields', async () => {
    expect((await POST(request())).status).toBe(202);
    expect(claimPredictionReferenceDownload).toHaveBeenCalledWith({}, 't'.repeat(43), 'model-test', {
      accession: payload.ncbi_accession, mode: 'predict', bases: 100,
    });
    expect(preparePredictionReference).toHaveBeenCalledWith(payload.ncbi_accession, 'ncbi', expect.any(AbortSignal));
    expect(vi.mocked(claimPredictionReferenceDownload).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(preparePredictionReference).mock.invocationCallOrder[0]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://docker.test/v1/jobs');
    expect(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer))).toEqual({ mode: 'predict', sequence: payload.sequence, complete_genome: true, reverse_complementary: true, reference_accession: payload.ncbi_accession });
    expect(init?.headers).toMatchObject({ Authorization: `Ticket ${'t'.repeat(43)}` });
  });

  it('never downloads when ticket claim fails (expired, replayed, invalid)', async () => {
    vi.mocked(claimPredictionReferenceDownload).mockResolvedValue(false);
    expect((await POST(request())).status).toBe(401);
    expect(preparePredictionReference).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { fasta: '>x\nACGT' }, { genome_context: 'ACGT' }, { reference_accession: 'GCF_000005845.1' },
    { reference_source: { url: 'https://evil.test' } }, { ncbi_accession: 'https://evil.test' },
    { mode: 'genome_scan' }, { sequence: 'A'.repeat(101) }, { complete_genome: false }, { reverse_complementary: 'true' },
  ])('rejects conflicting or invalid fields %j before download', async (extra) => {
    expect((await POST(request({ ...payload, ...extra }))).status).toBe(400);
    expect(preparePredictionReference).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed if D1 is unavailable', async () => {
    vi.mocked(usageDatabase).mockReturnValueOnce(null);
    expect((await POST(request())).status).toBe(503);
    expect(preparePredictionReference).not.toHaveBeenCalled();
  });

  it('reports missing migration or ticket configuration as authorization unavailable, not an NCBI outage', async () => {
    vi.mocked(claimPredictionReferenceDownload).mockRejectedValueOnce(new Error('missing migration'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAVAILABLE', message: expect.stringContaining('authorization is unavailable') } });
    expect(preparePredictionReference).not.toHaveBeenCalled();
  });

  it('does not queue a prediction while the reference is still preparing', async () => {
    vi.mocked(preparePredictionReference).mockRejectedValueOnce(new NcbiReferenceError('REFERENCE_PREPARING', 'Please retry shortly.', 409));
    expect((await POST(request())).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the ordinary catalog submission', async () => {
    const ordinary = { mode: 'predict', sequence: payload.sequence, reference_accession: 'GCF_000005845.1', complete_genome: true };
    expect((await POST(request(ordinary))).status).toBe(202);
    expect(preparePredictionReference).toHaveBeenCalledWith('GCF_000005845.1', 'catalog', expect.any(AbortSignal));
    expect(claimPredictionReferenceDownload).toHaveBeenCalledWith({}, 't'.repeat(43), 'model-test', {
      accession: 'GCF_000005845.1', mode: 'predict', bases: 100,
    });
  });

  it.each([
    ['ncbi_accession', 'ncbi'],
    ['reference_accession', 'catalog'],
  ] as const)('prepares and forwards a separate %s CGR reference for a partial genome scan', async (referenceField, source) => {
    const fasta = `>region_1\n${'ACGT'.repeat(75)}\n`;
    const scan = {
      mode: 'genome_scan', fasta, [referenceField]: 'GCF_000005845.2', complete_genome: true,
      stride: 2, score_cutoff: 0.9, reverse_complementary: false, output_formats: ['bigwig', 'gff3'],
    };
    expect((await POST(request(scan))).status).toBe(202);
    expect(claimPredictionReferenceDownload).toHaveBeenCalledWith({}, 't'.repeat(43), 'model-test', {
      accession: 'GCF_000005845.2', mode: 'genome_scan', bases: 300,
    });
    expect(preparePredictionReference).toHaveBeenCalledWith('GCF_000005845.2', source, expect.any(AbortSignal));
    expect(vi.mocked(claimPredictionReferenceDownload).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(preparePredictionReference).mock.invocationCallOrder[0]);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer))).toEqual({
      mode: 'genome_scan', fasta, reference_accession: 'GCF_000005845.2', complete_genome: true,
      stride: 2, score_cutoff: 0.9, reverse_complementary: false, output_formats: ['bigwig', 'gff3'],
    });
  });

  it.each([
    '>region\nACGTZ',
    `${'ACGT'.repeat(75)}`,
    '>region\n',
    '>same\nACGT\n>same\nACGT',
  ])('rejects invalid scan FASTA before claiming a reference download: %j', async (fasta) => {
    const scan = { mode: 'genome_scan', fasta, reference_accession: 'GCF_000005845.1', complete_genome: true };
    expect((await POST(request(scan))).status).toBe(400);
    expect(claimPredictionReferenceDownload).not.toHaveBeenCalled();
    expect(preparePredictionReference).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the existing FASTA-only genome scan path unchanged', async () => {
    const scan = {
      mode: 'genome_scan', fasta: `>region\n${'ACGT'.repeat(75)}\n`, complete_genome: true,
      stride: 1, reverse_complementary: true, output_formats: ['bigwig'],
    };
    expect((await POST(request(scan))).status).toBe(202);
    expect(claimPredictionReferenceDownload).not.toHaveBeenCalled();
    expect(preparePredictionReference).not.toHaveBeenCalled();
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer))).toEqual(scan);
  });

  it.each([null, [], 'invalid'])('rejects non-object JSON %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
  });
});
