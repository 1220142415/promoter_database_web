import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async (_ms, _value, options) => options.signal.throwIfAborted()) }));
vi.mock('@/features/prediction/reference-source', () => ({ resolvePredictionReferenceSource: vi.fn() }));
vi.mock('@/features/prediction/ncbi-reference', async (original) => ({
  ...await original<typeof import('@/features/prediction/ncbi-reference')>(),
  downloadNcbiFasta: vi.fn(),
}));

import { preparePredictionReference } from '@/features/prediction/reference-cache';
import { resolvePredictionReferenceSource } from '@/features/prediction/reference-source';
import { downloadNcbiFasta } from '@/features/prediction/ncbi-reference';

const accession = 'GCF_000005845.1';
const fasta = `>synthetic_transport_fixture\n${'ACGT'.repeat(25)}\n`;
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const state = (status: string, extra = {}) => Response.json({ accession, status, cgr_version: 'cgr-128-v1', source_sha256: sha(fasta), ...extra });

beforeEach(() => {
  vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_URL', 'https://docker.test');
  vi.stubEnv('RAPPTOR_PREDICTION_SERVICE_SECRET', 'private-service-secret');
  vi.mocked(downloadNcbiFasta).mockResolvedValue(fasta);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('cache-first reference transport', () => {
  it.each(['catalog', 'ncbi'] as const)('ready %s references need one protected query and zero downloads', async (source) => {
    const fetchMock = vi.fn(async () => state('ready'));
    vi.stubGlobal('fetch', fetchMock);
    await preparePredictionReference(accession, source, new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(`https://docker.test/v1/reference-cache/${accession}`, expect.objectContaining({ redirect: 'error', headers: { Authorization: 'Bearer private-service-secret' } }));
    expect(downloadNcbiFasta).not.toHaveBeenCalled();
    expect(resolvePredictionReferenceSource).not.toHaveBeenCalled();
  });

  it('imports original NCBI FASTA bytes with their SHA-256, then polls the returned import', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(state('missing'))
      .mockResolvedValueOnce(state('preparing', { import_id: 'a'.repeat(32) }))
      .mockResolvedValueOnce(state('ready', { import_id: 'a'.repeat(32) }));
    vi.stubGlobal('fetch', fetchMock);
    await preparePredictionReference(accession, 'ncbi', new AbortController().signal);
    expect(downloadNcbiFasta).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`https://docker.test/v1/reference-cache/${accession}/imports`);
    expect(init.headers).toMatchObject({ 'Content-Type': 'text/x-fasta', 'X-Source-SHA256': sha(fasta), 'X-CGR-Version': 'cgr-128-v1' });
    expect(init.headers).not.toHaveProperty('X-CGR-SHA256');
    expect(new TextDecoder().decode(init.body)).toBe(fasta);
    expect(fetchMock.mock.calls[2][0]).toBe(`https://docker.test/v1/reference-cache/imports/${'a'.repeat(32)}`);
  });

  it('verifies HF compressed bytes before importing decompressed FASTA without leaking service credentials', async () => {
    const packed = gzipSync(fasta);
    const url = 'https://huggingface.co/datasets/test/references/resolve/pinned/reference.fa.gz';
    vi.mocked(resolvePredictionReferenceSource).mockResolvedValue({ url, sha256: sha(packed) });
    const fetchMock = vi.fn().mockResolvedValueOnce(state('missing'))
      .mockResolvedValueOnce(new Response(packed)).mockResolvedValueOnce(state('ready'));
    vi.stubGlobal('fetch', fetchMock);
    await preparePredictionReference(accession, 'catalog', new AbortController().signal);
    expect(String(fetchMock.mock.calls[1][0])).toBe(url);
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('headers');
    expect(new TextDecoder().decode(fetchMock.mock.calls[2][1].body)).toBe(fasta);
  });

  it('does not start a duplicate download while another import prepares', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(state('preparing')).mockResolvedValueOnce(state('ready'));
    vi.stubGlobal('fetch', fetchMock);
    await preparePredictionReference(accession, 'ncbi', new AbortController().signal);
    expect(downloadNcbiFasta).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([, init]) => !init.method)).toBe(true);
  });

  it.each([
    { accession: 'GCF_000005845.2' }, { cgr_version: 'other-version' }, { source_sha256: null },
  ])('rejects incompatible ready responses %j', async (extra) => {
    vi.stubGlobal('fetch', vi.fn(async () => state('ready', extra)));
    await expect(preparePredictionReference(accession, 'catalog', new AbortController().signal)).rejects.toMatchObject({ code: 'CACHE_CONTRACT_MISMATCH' });
    expect(downloadNcbiFasta).not.toHaveBeenCalled();
  });

  it('never imports an HF checksum mismatch', async () => {
    vi.mocked(resolvePredictionReferenceSource).mockResolvedValue({ url: 'https://huggingface.co/datasets/test/ref/resolve/main/reference.fa', sha256: 'a'.repeat(64) });
    const fetchMock = vi.fn().mockResolvedValueOnce(state('missing')).mockResolvedValueOnce(new Response(fasta));
    vi.stubGlobal('fetch', fetchMock);
    await expect(preparePredictionReference(accession, 'catalog', new AbortController().signal)).rejects.toMatchObject({ code: 'REFERENCE_CHECKSUM_MISMATCH' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect to an unrelated host without fetching it', async () => {
    vi.mocked(resolvePredictionReferenceSource).mockResolvedValue({ url: 'https://huggingface.co/datasets/test/ref/resolve/main/reference.fa', sha256: sha(fasta) });
    const fetchMock = vi.fn().mockResolvedValueOnce(state('missing'))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(preparePredictionReference(accession, 'catalog', new AbortController().signal)).rejects.toMatchObject({ code: 'REFERENCE_SOURCE_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops waiting at the request deadline and preserves the in-progress import', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return state('preparing'); }));
    await expect(preparePredictionReference(accession, 'ncbi', controller.signal)).rejects.toMatchObject({ code: 'REFERENCE_PREPARING' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
