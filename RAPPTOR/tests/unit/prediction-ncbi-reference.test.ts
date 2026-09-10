import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const accession = 'GCF_000005845.2';
const basename = `${accession}_ASM584v2`;
const directory = `https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/005/845/${basename}`;
const fasta = '>test_reference\nACGTACGT\n';

function upstream(options: { path?: string; reportedAccession?: string; empty?: boolean; checksum?: string; fasta?: string } = {}) {
  const compressed = gzipSync(options.fasta ?? fasta);
  const checksum = options.checksum ?? createHash('md5').update(compressed).digest('hex');
  return vi.fn(async (input: string, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    if (input.includes('esearch.fcgi')) return Response.json({ esearchresult: { idlist: options.empty ? [] : ['123'] } });
    if (input.includes('esummary.fcgi')) return Response.json({ result: { uids: ['123'], '123': {
      assemblyaccession: options.reportedAccession ?? accession, organism: 'Example assembly',
      assemblystatus: 'Complete Genome', ftppath_refseq: options.path ?? directory,
    } } });
    if (input === `${directory}/md5checksums.txt`) return new Response(`${checksum}  ./${basename}_genomic.fna.gz\n`);
    if (input === `${directory}/${basename}_genomic.fna.gz`) return new Response(compressed);
    throw new Error(`Unexpected URL ${input}`);
  });
}

beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('NCBI reference lookup and bounded download', () => {
  it('returns metadata without a FASTA URL, caches it and verifies the official checksum on download', async () => {
    const fetchMock = upstream(); vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/prediction-references/ncbi/route');
    const result = await GET(new Request(`https://example.test/api/prediction-references/ncbi?accession=${accession}`));
    expect(await result.json()).toEqual({ items: [{ accession, organismName: 'Escherichia coli str. K-12 substr. MG1655', source: 'ncbi' }] });
    expect(fetchMock).not.toHaveBeenCalled();
    const { downloadNcbiFasta } = await import('@/features/prediction/ncbi-reference');
    expect(await downloadNcbiFasta(accession, AbortSignal.timeout(1000))).toBe(fasta);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(['GCF_000005845', 'https://evil.test/reference.fa', 'GCF_000005845.2/../x', 'GCF_1.2', null])('rejects invalid accession %s before network access', async (input) => {
    const fetchMock = upstream(); vi.stubGlobal('fetch', fetchMock);
    const { findNcbiReference } = await import('@/features/prediction/ncbi-reference');
    await expect(findNcbiReference(input)).rejects.toMatchObject({ code: 'INVALID_ACCESSION' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not substitute another assembly version', async () => {
    vi.stubGlobal('fetch', upstream({ reportedAccession: 'GCF_000005845.1' }));
    const { findNcbiReference } = await import('@/features/prediction/ncbi-reference');
    expect(await findNcbiReference(accession)).toBeNull();
  });

  it('falls back to the exact FTP assembly directory when E-utilities is unavailable', async () => {
    const parent = 'https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/005/845/';
    const directoryName = `${accession}_ASM584v2`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(`<a href="${directoryName}/">${directoryName}/</a>`))
      .mockResolvedValueOnce(new Response(`# Organism name: Escherichia coli str. K-12 substr. MG1655\n`));
    vi.stubGlobal('fetch', fetchMock);
    const { findNcbiReference } = await import('@/features/prediction/ncbi-reference');
    await expect(findNcbiReference(accession)).resolves.toMatchObject({
      accession,
      organismName: 'Escherichia coli str. K-12 substr. MG1655',
      directory: `${parent}${directoryName}`,
    });
  });

  it.each([
    'https://evil.test/genome', `${directory}/../../secret`, `${directory}?url=secret`,
    directory.replace('000/005/845', '000/005/846'), directory.replace('.2_ASM', '.1_ASM'),
  ])('rejects untrusted metadata paths: %s', async (path) => {
    const fetchMock = upstream({ path }); vi.stubGlobal('fetch', fetchMock);
    const { downloadNcbiFasta } = await import('@/features/prediction/ncbi-reference');
    await expect(downloadNcbiFasta(accession, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'NCBI_REFERENCE_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts the NCBI GenBank synonym only with a matching GCA path', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('esearch')
      ? Response.json({ esearchresult: { idlist: ['123'] } })
      : Response.json({ result: { '123': { assemblyaccession: accession, organism: 'Example', synonym: { genbank: 'GCA_000005845.2' }, ftppath_genbank: directory.replaceAll('GCF', 'GCA') } } })));
    const { findNcbiReference } = await import('@/features/prediction/ncbi-reference');
    expect(await findNcbiReference('GCA_000005845.2')).toMatchObject({ accession: 'GCA_000005845.2', source: 'ncbi' });
  });

  it('rejects checksum mismatch', async () => {
    vi.stubGlobal('fetch', upstream({ checksum: '0'.repeat(32) }));
    const { downloadNcbiFasta } = await import('@/features/prediction/ncbi-reference');
    await expect(downloadNcbiFasta(accession, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'NCBI_CHECKSUM_MISMATCH' });
  });

  it('bounds decompressed bytes even if the gzip file is small', async () => {
    vi.stubEnv('RAPPTOR_MAX_REQUEST_BYTES', '200');
    vi.stubGlobal('fetch', upstream({ fasta: `>test\n${'A'.repeat(1000)}\n` }));
    const { downloadNcbiFasta } = await import('@/features/prediction/ncbi-reference');
    await expect(downloadNcbiFasta(accession, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'REFERENCE_TOO_LARGE' });
  });

  it('bounds compressed bytes without relying on Content-Length', async () => {
    vi.stubEnv('RAPPTOR_MAX_REQUEST_BYTES', '10');
    vi.stubGlobal('fetch', upstream());
    const { downloadNcbiFasta } = await import('@/features/prediction/ncbi-reference');
    await expect(downloadNcbiFasta(accession, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'REFERENCE_TOO_LARGE' });
  });

  it('reports upstream failure rather than an empty search result', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429 })); vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/prediction-references/ncbi/route');
    expect((await GET(new Request('https://example.test/?accession=GCF_000005846.2'))).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
