import { describe, expect, it, vi } from 'vitest';
import { GET, HEAD } from '@/app/api/prediction-reference/[accession]/route';
import { loadPredictionReference } from '@/features/prediction/reference-source';
import { REAL_PREDICTION_REFERENCE, UPLOAD_PREDICTION_REFERENCE } from '@/features/prediction/reference-example';

vi.mock('@/features/prediction/reference-source', () => ({ loadPredictionReference: vi.fn() }));
const context = (accession = REAL_PREDICTION_REFERENCE.accession) => ({ params: Promise.resolve({ accession }) });
const request = () => new Request('http://localhost/test');

describe('verified prediction reference route', () => {
  it('rejects references outside the fixed allowlist without loading data', async () => {
    expect((await GET(request(), context('GCF_000000001.1'))).status).toBe(404);
    expect(loadPredictionReference).not.toHaveBeenCalled();
  });
  it('serves verified plain FASTA and matching HEAD checksum/length', async () => {
    const fasta = '>test\nACGT\n'; // Loader contract is tested separately.
    vi.mocked(loadPredictionReference).mockResolvedValue(fasta);
    const response = await GET(request(), context());
    const head = await HEAD(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('x-reference-sha256')).toBe(REAL_PREDICTION_REFERENCE.fastaSha256);
    expect(response.headers.get('content-length')).toBe(String(fasta.length));
    expect([...head.headers]).toEqual([...response.headers]);
    expect(await response.text()).toBe(fasta);
    expect(await head.text()).toBe('');
  });
  it('serves the NCBI upload example under its own accession and checksum', async () => {
    vi.mocked(loadPredictionReference).mockResolvedValue('>NC_000913.3\nACGT\n');
    const response = await GET(request(), context(UPLOAD_PREDICTION_REFERENCE.accession));
    expect(response.status).toBe(200);
    expect(loadPredictionReference).toHaveBeenCalledWith('GCF_000005845.2');
    expect(response.headers.get('x-reference-sha256')).toBe(UPLOAD_PREDICTION_REFERENCE.fastaSha256);
    expect(response.headers.get('content-disposition')).toContain(UPLOAD_PREDICTION_REFERENCE.fileName);
    expect(response.headers.get('etag')).not.toContain(REAL_PREDICTION_REFERENCE.fastaSha256);
  });
  it.each(['unavailable', 'checksum mismatch', 'size limit'])('returns an uncached error when the reference is %s', async (reason) => {
    vi.mocked(loadPredictionReference).mockRejectedValue(new Error(reason));
    const response = await GET(request(), context());
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('could not be loaded and verified');
  });
});
