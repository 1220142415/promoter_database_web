const CACHE_NAME = 'rapptor-on-demand-genomes-v1';
export const MAX_FULL_SCORE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_STATIC_ASSET_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_DECOMPRESSED_ASSET_BYTES = 256 * 1024 * 1024;

export type GenomeAssetProgress = {
  phase: 'downloading' | 'caching' | 'cached';
  loaded: number;
  total: number | null;
};

type LoadGenomeAssetOptions = {
  maximumBytes?: number;
  onProgress?: (progress: GenomeAssetProgress) => void;
};

function responseSize(headers: Headers) {
  const header = headers.get('content-length') || headers.get('x-linked-size');
  if (!header) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sizeError(maximumBytes: number) {
  const limit = maximumBytes >= 1024 * 1024
    ? `${(maximumBytes / 1024 / 1024).toFixed(0)} MiB`
    : `${maximumBytes} byte${maximumBytes === 1 ? '' : 's'}`;
  return new Error(`Genome asset exceeds the ${limit} browser download limit.`);
}

async function readBlob(
  response: Response,
  maximumBytes: number,
  onProgress?: (loaded: number, total: number | null) => void,
) {
  const total = responseSize(response.headers);
  if (total !== null && total > maximumBytes) throw sizeError(maximumBytes);
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > maximumBytes) throw sizeError(maximumBytes);
    onProgress?.(blob.size, total || blob.size);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  onProgress?.(0, total);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      if (loaded > maximumBytes) {
        await reader.cancel();
        throw sizeError(maximumBytes);
      }
      chunks.push(value as BlobPart);
      onProgress?.(loaded, total);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: response.headers.get('content-type') || '' });
}

export function firstFastaRefName(text: string) {
  return /^>(\S+)/m.exec(text)?.[1] || null;
}

export async function maybeDecompressGzip(blob: Blob, maximumBytes = MAX_DECOMPRESSED_ASSET_BYTES) {
  const signature = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  if (signature[0] !== 0x1f || signature[1] !== 0x8b || signature[2] !== 0x08) {
    if (blob.size > maximumBytes) throw sizeError(maximumBytes);
    return blob;
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the reference assembly.');
  }
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return readBlob(new Response(stream), maximumBytes);
}

export async function loadCachedGenomeAsset(
  url: string,
  cacheKey: string,
  signal: AbortSignal,
  { maximumBytes = MAX_STATIC_ASSET_DOWNLOAD_BYTES, onProgress }: LoadGenomeAssetOptions = {},
) {
  const cacheOrigin = typeof location === 'undefined' ? 'https://rapptor.invalid' : location.origin;
  const request = new Request(new URL(`/__rapptor-browser-cache/${encodeURIComponent(cacheKey)}`, cacheOrigin));
  let cache: Cache | null = null;
  let response: Response | undefined;
  if ('caches' in globalThis) {
    try {
      cache = await caches.open(CACHE_NAME);
      response = await cache.match(request);
    } catch {
      cache = null;
    }
  }
  if (response) {
    const blob = await readBlob(response, maximumBytes);
    onProgress?.({ phase: 'cached', loaded: blob.size, total: blob.size });
    return blob;
  }

  response = await fetch(url, {
    cache: 'no-cache',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (!response.ok) throw new Error(`Genome asset is unavailable (HTTP ${response.status}).`);
  const blob = await readBlob(response, maximumBytes, (loaded, total) => {
    onProgress?.({ phase: 'downloading', loaded, total });
  });
  if (cache) {
    try {
      onProgress?.({ phase: 'caching', loaded: blob.size, total: blob.size });
      await cache.put(request, new Response(blob, {
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      }));
    } catch {
      // Loading must still work when private mode or quota policy disables Cache Storage.
    }
  }
  onProgress?.({ phase: 'cached', loaded: blob.size, total: blob.size });
  return blob;
}

export async function shouldDownloadWholeAsset(
  url: string,
  signal: AbortSignal,
  maximumBytes = MAX_FULL_SCORE_DOWNLOAD_BYTES,
) {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      cache: 'no-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (!response.ok) return false;
    const sizeHeader = response.headers.get('content-length') || response.headers.get('x-linked-size');
    if (!sizeHeader) return false;
    const size = Number(sizeHeader);
    return Number.isSafeInteger(size) && size >= 0 && size <= maximumBytes;
  } catch {
    return false;
  }
}
