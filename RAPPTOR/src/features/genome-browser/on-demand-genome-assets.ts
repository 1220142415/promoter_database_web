const CACHE_NAME = 'rapptor-on-demand-genomes-v1';
export const MAX_FULL_SCORE_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export function firstFastaRefName(text: string) {
  return /^>(\S+)/m.exec(text)?.[1] || null;
}

export async function maybeDecompressGzip(blob: Blob) {
  const signature = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  if (signature[0] !== 0x1f || signature[1] !== 0x8b || signature[2] !== 0x08) return blob;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the reference assembly.');
  }
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).blob();
}

export async function loadCachedGenomeAsset(url: string, cacheKey: string, signal: AbortSignal) {
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
  if (!response) {
    response = await fetch(url, {
      cache: 'no-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (!response.ok) throw new Error(`Genome asset is unavailable (HTTP ${response.status}).`);
    if (cache) {
      try {
        await cache.put(request, response.clone());
      } catch {
        // Loading must still work when private mode or quota policy disables Cache Storage.
      }
    }
  }
  return response.blob();
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
