import 'server-only';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { DEFAULT_PREDICTION_MAX_REQUEST_BYTES, predictionMaxRequestBytes } from './capabilities';
import { boundedBytes, downloadNcbiFasta, NcbiReferenceError } from './ncbi-reference';
import { resolvePredictionReferenceSource } from './reference-source';

interface CacheState {
  accession: string;
  status: 'ready' | 'missing' | 'preparing' | 'invalid' | 'failed';
  cgr_version: string;
  source_sha256?: string | null;
  import_id?: string | null;
}

async function cacheRequest(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<CacheState> {
  const base = process.env.RAPPTOR_PREDICTION_SERVICE_URL?.trim().replace(/\/+$/, '');
  const secret = process.env.RAPPTOR_PREDICTION_SERVICE_SECRET;
  if (!base || !secret) throw new NcbiReferenceError('CACHE_SERVICE_UNAVAILABLE', 'Reference preparation is not configured.', 503);
  const response = await fetch(`${base}/v1/reference-cache/${path}`, {
    ...init, signal, redirect: 'error', cache: 'no-store',
    headers: { ...init.headers, Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new NcbiReferenceError('CACHE_SERVICE_UNAVAILABLE', 'Reference preparation is temporarily unavailable. Please try again later.', 503);
  }
  const state = JSON.parse(new TextDecoder().decode(await boundedBytes(response.body, 8192))) as CacheState;
  if (!state || !['ready', 'missing', 'preparing', 'invalid', 'failed'].includes(state.status)
    || !/^GC[AF]_\d{9}\.[1-9]\d{0,3}$/.test(state.accession)
    || state.cgr_version !== 'cgr-128-v1') {
    throw new NcbiReferenceError('CACHE_CONTRACT_MISMATCH', 'Reference cache response is incompatible.', 502);
  }
  return state;
}

async function catalogFasta(accession: string, signal: AbortSignal): Promise<string> {
  const source = await resolvePredictionReferenceSource(accession);
  if (!source) throw new NcbiReferenceError('REFERENCE_CGR_NOT_FOUND', 'This exact reference version is unavailable. Choose another reference or upload its complete FASTA.', 404);
  let url = new URL(source.url);
  if (url.origin !== 'https://huggingface.co' || !url.pathname.startsWith('/datasets/')) {
    throw new NcbiReferenceError('REFERENCE_SOURCE_UNAVAILABLE', 'This catalog reference cannot be downloaded.', 502);
  }
  const limit = Math.min(predictionMaxRequestBytes(), DEFAULT_PREDICTION_MAX_REQUEST_BYTES);
  for (let redirects = 0; redirects < 5; redirects++) {
    // HF may redirect immutable assets to its signed CDN. Never forward service credentials.
    if (url.protocol !== 'https:' || url.username || url.password
      || !['huggingface.co', 'hf.co'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      throw new NcbiReferenceError('REFERENCE_SOURCE_UNAVAILABLE', 'The reference download location is unsupported.', 502);
    }
    const response = await fetch(url, { signal, redirect: 'manual', cache: 'no-store' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); break; }
    const packed = await boundedBytes(response.body, limit);
    if (createHash('sha256').update(packed).digest('hex') !== source.sha256) {
      throw new NcbiReferenceError('REFERENCE_CHECKSUM_MISMATCH', 'The reference download failed its checksum check.', 502);
    }
    const bytes = packed[0] === 0x1f && packed[1] === 0x8b
      ? await boundedBytes(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip')), limit)
      : packed;
    const fasta = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!fasta.startsWith('>') || fasta.includes('\0')) break;
    return fasta;
  }
  throw new NcbiReferenceError('REFERENCE_SOURCE_UNAVAILABLE', 'The catalog reference could not be downloaded. Your input is unchanged.', 503);
}

/** One bounded preparation per claimed ticket. Docker alone persists the resulting CGR. */
export async function preparePredictionReference(accession: string, source: 'catalog' | 'ncbi', signal: AbortSignal) {
  if (!/^GC[AF]_\d{9}\.[1-9]\d{0,3}$/.test(accession)) throw new NcbiReferenceError('INVALID_ACCESSION', 'Select an exact assembly version.', 400);
  let expectedHash: string | undefined;
  let state = await cacheRequest(accession, signal);
  const check = () => {
    if (state.accession !== accession) throw new NcbiReferenceError('CACHE_CONTRACT_MISMATCH', 'Reference cache returned a different assembly version.', 502);
    if (state.status === 'failed') throw new NcbiReferenceError('REFERENCE_IMPORT_FAILED', 'Reference preparation failed. Please try again later.', 502);
    if (expectedHash && state.source_sha256 !== expectedHash) throw new NcbiReferenceError('REFERENCE_SOURCE_CONFLICT', 'The cached reference does not match the imported source.', 409);
    if (state.status === 'ready' && !/^[a-f0-9]{64}$/.test(state.source_sha256 || '')) {
      throw new NcbiReferenceError('CACHE_CONTRACT_MISMATCH', 'Reference cache metadata is incomplete.', 502);
    }
  };
  check();
  if (state.status === 'ready') return;
  if (state.status !== 'preparing') {
    const fasta = source === 'ncbi' ? await downloadNcbiFasta(accession, signal) : await catalogFasta(accession, signal);
    const bytes = new TextEncoder().encode(fasta);
    if (bytes.byteLength > Math.min(predictionMaxRequestBytes(), DEFAULT_PREDICTION_MAX_REQUEST_BYTES)) {
      throw new NcbiReferenceError('REFERENCE_TOO_LARGE', 'The reference exceeds the download limit.', 413);
    }
    expectedHash = createHash('sha256').update(bytes).digest('hex');
    state = await cacheRequest(`${accession}/imports`, signal, {
      method: 'POST', body: bytes,
      headers: { 'Content-Type': 'text/x-fasta', 'X-CGR-Version': 'cgr-128-v1', 'X-Source-SHA256': expectedHash },
    });
    check();
  }
  while (state.status === 'preparing') {
    try {
      await wait(3000, undefined, { signal });
      const path = state.import_id && /^[a-f0-9]{32}$/.test(state.import_id) ? `imports/${state.import_id}` : accession;
      state = await cacheRequest(path, signal);
      check();
    } catch (cause) {
      if (!signal.aborted) throw cause;
      throw new NcbiReferenceError('REFERENCE_PREPARING', 'The reference is still being prepared. Your input is kept; please retry shortly.', 409);
    }
  }
  if (state.status !== 'ready') throw new NcbiReferenceError('REFERENCE_IMPORT_FAILED', 'Reference preparation did not complete.', 502);
}
