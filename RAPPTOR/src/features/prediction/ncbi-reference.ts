import 'server-only';
import { createHash } from 'node:crypto';
import { predictionMaxRequestBytes, DEFAULT_PREDICTION_MAX_REQUEST_BYTES } from './capabilities';

export class NcbiReferenceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); }
}

export interface NcbiReference {
  accession: string;
  organismName: string;
  source: 'ncbi';
  directory: string;
}

export function ncbiAccession(value: unknown): string {
  if (typeof value !== 'string' || !/^GC[AF]_\d{9}\.[1-9]\d{0,3}$/i.test(value.trim())) {
    throw new NcbiReferenceError('INVALID_ACCESSION', 'Enter a versioned assembly ID, such as GCF_000005845.2.', 400);
  }
  return value.trim().toUpperCase();
}

// Metadata only: never keep genome bytes in a Worker isolate or D1.
const metadataCache = new Map<string, { expires: number; value: NcbiReference | null }>();
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const MAX_METADATA_BYTES = 256 * 1024;

export async function boundedBytes(stream: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!stream) throw new NcbiReferenceError('NCBI_UNAVAILABLE', 'NCBI returned an empty response.');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new NcbiReferenceError('REFERENCE_TOO_LARGE', 'The NCBI reference exceeds the download limit.', 413);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function fetchBytes(url: string, signal: AbortSignal, maxBytes: number) {
  const response = await fetch(url, { signal, redirect: 'error', cache: 'no-store' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new NcbiReferenceError('NCBI_UNAVAILABLE', 'NCBI could not supply this reference. Please try again later.', response.status === 429 ? 503 : 502);
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new NcbiReferenceError('REFERENCE_TOO_LARGE', 'The NCBI reference exceeds the download limit.', 413);
  }
  return boundedBytes(response.body, maxBytes);
}

async function metadataJson(path: string, signal: AbortSignal) {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(`${EUTILS}${path}`, signal, MAX_METADATA_BYTES)));
}

function safeDirectory(value: unknown, accession: string) {
  if (typeof value !== 'string') throw new NcbiReferenceError('NCBI_REFERENCE_UNAVAILABLE', 'This assembly has no downloadable genomic FASTA.', 404);
  const match = /^GC([AF])_(\d{3})(\d{3})(\d{3})\.(\d+)$/.exec(accession)!;
  const prefix = `https://ftp.ncbi.nlm.nih.gov/genomes/all/GC${match[1]}/${match[2]}/${match[3]}/${match[4]}/${accession}_`;
  const directory = value.replace(/^ftp:\/\//, 'https://').replace(/\/$/, '');
  if (!directory.startsWith(prefix) || !/^[A-Za-z0-9_.-]+$/.test(directory.slice(prefix.length))) {
    throw new NcbiReferenceError('NCBI_REFERENCE_UNAVAILABLE', 'NCBI returned an unsupported assembly location.', 404);
  }
  return directory;
}

export async function findNcbiReference(input: unknown, signal = AbortSignal.timeout(10_000)): Promise<NcbiReference | null> {
  const accession = ncbiAccession(input);
  const cached = metadataCache.get(accession);
  if (cached && cached.expires > Date.now()) return cached.value;
  const search = await metadataJson(`esearch.fcgi?db=assembly&retmode=json&retmax=5&term=${encodeURIComponent(`${accession}[Assembly Accession]`)}`, signal);
  if (!Array.isArray(search?.esearchresult?.idlist) || search.error) throw new NcbiReferenceError('NCBI_UNAVAILABLE', 'NCBI search is unavailable.');
  const ids = search.esearchresult.idlist as unknown[];
  let value: NcbiReference | null = null;
  if (ids.length) {
    if (ids.length > 5 || ids.some((id) => typeof id !== 'string' || !/^\d+$/.test(id))) throw new NcbiReferenceError('NCBI_UNAVAILABLE', 'NCBI search returned invalid identifiers.');
    const summary = await metadataJson(`esummary.fcgi?db=assembly&retmode=json&id=${ids.join(',')}`, signal);
    if (!summary?.result || summary.error) throw new NcbiReferenceError('NCBI_UNAVAILABLE', 'NCBI assembly metadata is unavailable.');
    for (const id of ids as string[]) {
      const record = summary.result[id];
      if (!record || record.error) throw new NcbiReferenceError('NCBI_UNAVAILABLE', 'NCBI assembly metadata is unavailable.');
      // RefSeq and GenBank may share an Assembly UID; only accept the exact requested version.
      if (![record.assemblyaccession, record.synonym?.refseq, record.synonym?.genbank].includes(accession)) continue;
      if (['suppressed', 'withdrawn'].includes(String(record.assemblystatus).toLowerCase())) continue;
      const directory = safeDirectory(accession.startsWith('GCF_') ? record.ftppath_refseq : record.ftppath_genbank, accession);
      if (typeof record.organism !== 'string' || !record.organism.trim()) throw new NcbiReferenceError('NCBI_UNAVAILABLE', 'NCBI assembly metadata is incomplete.');
      value = { accession, organismName: record.organism.slice(0, 500), source: 'ncbi', directory };
      break;
    }
  }
  if (metadataCache.size >= 128) metadataCache.delete(metadataCache.keys().next().value!);
  metadataCache.set(accession, { value, expires: Date.now() + (value ? 300_000 : 60_000) });
  return value;
}

export async function downloadNcbiFasta(accession: string, signal: AbortSignal) {
  const reference = await findNcbiReference(accession, signal);
  if (!reference) throw new NcbiReferenceError('NCBI_REFERENCE_NOT_FOUND', 'This exact assembly version was not found at NCBI.', 404);
  const directory = safeDirectory(reference.directory, accession);
  const filename = `${directory.slice(directory.lastIndexOf('/') + 1)}_genomic.fna.gz`;
  const manifest = new TextDecoder().decode(await fetchBytes(`${directory}/md5checksums.txt`, signal, MAX_METADATA_BYTES));
  const checksum = manifest.split(/\r?\n/).map((line) => /^([a-f0-9]{32})\s+\.?\/?(.+)$/i.exec(line))
    .find((entry) => entry?.[2] === filename)?.[1].toLowerCase();
  if (!checksum) throw new NcbiReferenceError('NCBI_CHECKSUM_UNAVAILABLE', 'NCBI has no checksum for this genomic FASTA.');
  // Hard ceiling also protects isolate memory if the general upload limit is raised.
  const limit = Math.min(predictionMaxRequestBytes(), DEFAULT_PREDICTION_MAX_REQUEST_BYTES);
  const compressed = await fetchBytes(`${directory}/${filename}`, signal, limit);
  if (createHash('md5').update(compressed).digest('hex') !== checksum) {
    throw new NcbiReferenceError('NCBI_CHECKSUM_MISMATCH', 'The downloaded reference failed the NCBI checksum check.');
  }
  const decompressed = await boundedBytes(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')), limit);
  signal.throwIfAborted();
  const fasta = new TextDecoder('utf-8', { fatal: true }).decode(decompressed);
  if (!fasta.startsWith('>') || fasta.includes('\0')) throw new NcbiReferenceError('NCBI_INVALID_FASTA', 'NCBI did not return genomic FASTA.');
  // Docker retains authoritative FASTA alphabet, record and CGR validation.
  return fasta;
}

export function ncbiErrorResponse(cause: unknown) {
  const error = cause instanceof NcbiReferenceError ? cause
    : new NcbiReferenceError('NCBI_UNAVAILABLE', 'The NCBI reference could not be loaded in time. Your input is unchanged. Please try again later.', 503);
  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
}
