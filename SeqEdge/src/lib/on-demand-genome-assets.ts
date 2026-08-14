const CACHE_NAME = 'seqedge-on-demand-genomes-v1';
const MAX_CACHE_ENTRIES = 12;

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

async function prune(cache: Cache) {
  try {
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_CACHE_ENTRIES)).map((key) => cache.delete(key)));
  } catch {
    // Cache eviction is best effort; browser quota policy remains authoritative.
  }
}

export async function loadCachedGenomeAsset(url: string, cacheKey: string, signal: AbortSignal) {
  const cacheOrigin = typeof location === 'undefined' ? 'https://seqedge.invalid' : location.origin;
  const request = new Request(new URL(`/__seqedge-browser-cache/${encodeURIComponent(cacheKey)}`, cacheOrigin));
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
    response = await fetch(url, { cache: 'force-cache', credentials: 'omit', signal });
    if (!response.ok) throw new Error(`Genome asset is unavailable (HTTP ${response.status}).`);
    if (cache) {
      try {
        await cache.put(request, response.clone());
        await prune(cache);
      } catch {
        // Loading must still work when private mode or quota policy disables Cache Storage.
      }
    }
  }
  return response.blob();
}
