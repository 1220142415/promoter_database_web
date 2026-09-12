import 'server-only';
import { createHash } from 'node:crypto';
import { predictionMaxRequestBytes, DEFAULT_PREDICTION_MAX_REQUEST_BYTES } from './capabilities';
import { predictionReferenceExample } from './reference-example';
import { loadPredictionReference } from './reference-source';

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
const DATASETS = 'https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/';
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

const NCBI_HEADERS = {
  Accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
};

async function fetchBytes(url: string, signal: AbortSignal, maxBytes: number, headers: HeadersInit = NCBI_HEADERS) {
  const response = await fetch(url, { signal, redirect: 'error', cache: 'no-store', headers });
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
  return JSON.parse(new TextDecoder().decode(await fetchBytes(`${DATASETS}${path}`, signal, MAX_METADATA_BYTES)));
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function assemblyParent(accession: string) {
  const match = /^GC([AF])_(\d{3})(\d{3})(\d{3})\.(\d+)$/.exec(accession)!;
  return `https://ftp.ncbi.nlm.nih.gov/genomes/all/GC${match[1]}/${match[2]}/${match[3]}/${match[4]}/`;
}

async function findNcbiReferenceFromFtp(accession: string, signal: AbortSignal): Promise<NcbiReference | null> {
  const parent = assemblyParent(accession);
  const listing = new TextDecoder().decode(await fetchBytes(parent, signal, MAX_METADATA_BYTES, {
    Accept: 'text/html, text/plain;q=0.9, */*;q=0.1',
  }));
  const escaped = accession.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = [...listing.matchAll(new RegExp(`(?:href=["']?)(${escaped}_[A-Za-z0-9_.-]+)(?:/["']?)`, 'gi'))]
    .map((match) => match[1])
    .filter((value, index, all) => all.indexOf(value) === index);
  const directoryName = candidates[0];
  if (!directoryName) return null;
  const directory = `${parent}${directoryName}`;
  let organismName = `NCBI assembly ${accession}`;
  try {
    const report = new TextDecoder().decode(await fetchBytes(`${directory}/${directoryName}_assembly_report.txt`, signal, MAX_METADATA_BYTES, {
      Accept: 'text/plain, */*;q=0.1',
    }));
    const match = report.match(/^#\s*Organism name:\s*(.+)$/mi);
    if (match?.[1]?.trim()) organismName = match[1].trim().slice(0, 500);
  } catch {
    // The directory itself is sufficient to prepare the exact reference; name is display-only.
  }
  return { accession, organismName, source: 'ncbi', directory };
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

export async function findNcbiReference(input: unknown, signal?: AbortSignal): Promise<NcbiReference | null> {
  const accession = ncbiAccession(input);
  const example = predictionReferenceExample(accession);
  if (example) {
    const url = new URL(example.sourceUrl);
    if (url.hostname === 'ftp.ncbi.nlm.nih.gov') {
      return { accession, organismName: example.organism, source: 'ncbi', directory: new URL('.', url).toString().replace(/\/$/, '') };
    }
  }
  const cached = metadataCache.get(accession);
  if (cached && cached.expires > Date.now()) return cached.value;
  let value: NcbiReference | null = null;
  const metadataTimeout = withTimeout(signal, 10_000);
  try {
    const report = await metadataJson(`${accession}/dataset_report?page_size=1`, metadataTimeout.signal);
    const record = Array.isArray(report?.reports) ? report.reports[0] : null;
    if (record) {
      if (![record.accession, record.current_accession, record.paired_accession].includes(accession)) return null;
      if (String(record.assembly_info?.assembly_status).toLowerCase() !== 'current') return null;
      const assemblyName = record.assembly_info?.assembly_name;
      const organismName = record.organism?.organism_name;
      if (typeof assemblyName !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(assemblyName)
        || typeof organismName !== 'string' || !organismName.trim()) {
        throw new NcbiReferenceError('NCBI_REFERENCE_UNAVAILABLE', 'NCBI assembly metadata is incomplete.', 404);
      }
      value = { accession, organismName: organismName.slice(0, 500), source: 'ncbi', directory: `${assemblyParent(accession)}${accession}_${assemblyName}` };
    }
  } catch (cause) {
    if (cause instanceof NcbiReferenceError && cause.code !== 'NCBI_UNAVAILABLE') throw cause;
    if (signal?.aborted && signal.reason?.name !== 'TimeoutError') throw cause;
    const fallbackTimeout = withTimeout(signal?.reason?.name === 'TimeoutError' ? undefined : signal, 8_000);
    try { value = await findNcbiReferenceFromFtp(accession, fallbackTimeout.signal); }
    finally { fallbackTimeout.cleanup(); }
  } finally {
    metadataTimeout.cleanup();
  }
  if (metadataCache.size >= 128) metadataCache.delete(metadataCache.keys().next().value!);
  metadataCache.set(accession, { value, expires: Date.now() + (value ? 300_000 : 60_000) });
  return value;
}

export async function downloadNcbiFasta(accession: string, signal: AbortSignal) {
  const example = predictionReferenceExample(accession);
  if (example && new URL(example.sourceUrl).hostname === 'ftp.ncbi.nlm.nih.gov') return loadPredictionReference(accession);
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
    : new NcbiReferenceError('NCBI_UNAVAILABLE', 'NCBI lookup is temporarily unavailable. Upload the complete genome FASTA or try again later.', 503);
  if (!(cause instanceof NcbiReferenceError)) console.error('NCBI reference lookup failed', cause);
  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
}
