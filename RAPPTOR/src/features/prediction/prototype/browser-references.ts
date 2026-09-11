const NCBI_DATASETS = 'https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/';
const NCBI_FTP = 'https://ftp.ncbi.nlm.nih.gov/genomes/all/';
const FASTA_CACHE = 'rapptor-reference-fasta-v1';

export interface BrowserReferenceSearchResult {
  accession: string;
  organismName: string;
  source: 'ncbi';
  referenceUrl: string | null;
  genomeSizeBp: number | null;
}

function validAccession(value: string) {
  return /^GC[AF]_\d{9}\.[1-9]\d{0,3}$/i.test(value);
}

function ftpParent(accession: string) {
  const match = /^GC([AF])_(\d{3})(\d{3})(\d{3})\./i.exec(accession);
  if (!match) throw new Error('Enter a versioned assembly ID, such as GCF_000005845.2.');
  return `${NCBI_FTP}GC${match[1].toUpperCase()}/${match[2]}/${match[3]}/${match[4]}/`;
}

export async function findBrowserNcbiReference(value: string, signal?: AbortSignal): Promise<BrowserReferenceSearchResult> {
  const accession = value.trim().toUpperCase();
  if (!validAccession(accession)) throw new Error('Enter a versioned assembly ID, such as GCF_000005845.2.');
  const response = await fetch(`${NCBI_DATASETS}${encodeURIComponent(accession)}/dataset_report?page_size=1`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error('NCBI lookup is temporarily unavailable.');
  const payload = await response.json() as {
    items?: Array<{ accession?: unknown; organismName?: unknown; source?: unknown }>;
    reports?: Array<{
      accession?: unknown;
      current_accession?: unknown;
      paired_accession?: unknown;
      assembly_info?: { assembly_status?: unknown; assembly_name?: unknown };
      assembly_stats?: { total_sequence_length?: unknown };
      organism?: { organism_name?: unknown };
    }>;
  };
  const legacyItem = payload.items?.[0];
  if (legacyItem && typeof legacyItem.accession === 'string' && typeof legacyItem.organismName === 'string') {
    return {
      accession: legacyItem.accession.toUpperCase(),
      organismName: legacyItem.organismName,
      source: 'ncbi',
      referenceUrl: null,
      genomeSizeBp: null,
    };
  }
  const report = payload.reports?.[0];
  const info = report?.assembly_info;
  const assemblyName = typeof info?.assembly_name === 'string' ? info.assembly_name.trim() : '';
  const organismName = typeof report?.organism?.organism_name === 'string' ? report.organism.organism_name.trim() : '';
  const reportedAccessions = [report?.accession, report?.current_accession, report?.paired_accession]
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.toUpperCase());
  if (!report || !reportedAccessions.includes(accession) || String(info?.assembly_status).toLowerCase() !== 'current'
    || !/^[A-Za-z0-9_.-]+$/.test(assemblyName) || !organismName) {
    throw new Error('This exact assembly version was not found at NCBI.');
  }
  const directory = `${ftpParent(accession)}${accession}_${assemblyName}`;
  return {
    accession,
    organismName: organismName.slice(0, 500),
    source: 'ncbi',
    referenceUrl: `${directory}/${accession}_${assemblyName}_genomic.fna.gz`,
    genomeSizeBp: Number.isFinite(Number(report.assembly_stats?.total_sequence_length))
      ? Number(report.assembly_stats?.total_sequence_length)
      : null,
  };
}

function isGzip(url: string, response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (/^text\/plain(?:;|$)/i.test(contentType)) return false;
  return /\.gz(?:$|[?#])/i.test(new URL(url).pathname)
    || /gzip|x-gzip/i.test(contentType);
}

function validateFasta(text: string) {
  if (!text.trimStart().startsWith('>')) throw new Error('Selected genome FASTA is invalid.');
  return text;
}

export async function downloadBrowserFasta(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void,
  signal?: AbortSignal,
) {
  const parsed = new URL(url, window.location.href);
  const sameOrigin = parsed.origin === window.location.origin;
  if (!sameOrigin && (parsed.protocol !== 'https:' || !['ftp.ncbi.nlm.nih.gov', 'huggingface.co'].includes(parsed.hostname))) {
    throw new Error('Reference download URL is not allowed.');
  }
  const cache = typeof caches === 'undefined' ? null : await caches.open(FASTA_CACHE).catch(() => null);
  const cached = await cache?.match(parsed.toString()).catch(() => undefined);
  if (cached) {
    try { return validateFasta(await cached.text()); } catch { /* Download a fresh copy below. */ }
  }
  const response = await fetch(parsed.toString(), { cache: 'no-store', signal });
  if (!response.ok || !response.body) throw new Error('Selected genome FASTA is unavailable.');
  const totalHeader = Number(response.headers.get('content-length'));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = new Response(bytes.buffer).body;
  if (!body) throw new Error('Selected genome FASTA is unavailable.');
  const text = isGzip(parsed.toString(), response)
    ? await new Response(body.pipeThrough(new DecompressionStream('gzip'))).text()
    : await new Response(body).text();
  validateFasta(text);
  await cache?.put(parsed.toString(), new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } })).catch(() => undefined);
  return text;
}
