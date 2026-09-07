import 'server-only';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { experimentalTssRepository } from '@/features/genome-browser/experimental-tss-repository';
import { genomeCatalogRepository } from '@/features/genomes/repository';
import type { GenomeCatalogMatch } from '@/features/genomes/types';
import { REAL_PREDICTION_REFERENCE, validateReferenceExample } from './reference-example';

const ACCESSION = /^GCF_\d{9}\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface PredictionReferenceSource {
  url: string;
  sha256: string;
}

export function referenceSourceFromMatch(
  accession: string,
  match: GenomeCatalogMatch | null,
): PredictionReferenceSource | null {
  let url = match?.plannedAssets?.reference;
  if (!url && match?.storage?.layout === 'individual-v1' && match.storage.baseUrl) {
    try {
      url = new URL(match.genome.assets.fasta, match.storage.baseUrl.replace(/\/+$/, '') + '/').toString();
    } catch {
      url = undefined;
    }
  }
  const sha256 = match?.plannedAssets?.cacheVersions.reference
    || match?.details?.referenceSha256
    || match?.referenceSha256;
  if (!ACCESSION.test(accession) || match?.genome.accession !== accession || !url || !sha256 || !SHA256.test(sha256)) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return { url, sha256 };
}

export async function resolvePredictionReferenceSource(accession: string) {
  if (!ACCESSION.test(accession)) return null;
  const catalogSource = referenceSourceFromMatch(
    accession,
    await genomeCatalogRepository.getByAccession(accession),
  );
  if (catalogSource) return catalogSource;

  const experimentalAsset = await experimentalTssRepository.resolveAsset(accession, 'reference.fa.gz');
  if (!experimentalAsset?.sha256 || !SHA256.test(experimentalAsset.sha256)) return null;
  try {
    const parsed = new URL(experimentalAsset.upstreamUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return { url: experimentalAsset.upstreamUrl, sha256: experimentalAsset.sha256 };
}

const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_FASTA_BYTES = 8 * 1024 * 1024;
let pending: Promise<string> | undefined;

async function loadReference(): Promise<string> {
  const localCache = process.env.NODE_ENV === 'development';
  const cacheDir = join(process.cwd(), '.data', 'prediction-examples');
  const cacheFile = join(cacheDir, REAL_PREDICTION_REFERENCE.fileName);
  if (localCache) {
    try {
      const text = await readFile(cacheFile, 'utf8');
      await validateReferenceExample(text);
      return text;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }
  const response = await fetch(REAL_PREDICTION_REFERENCE.sourceUrl, { cache: 'no-store', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error('Prediction reference is unavailable.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_COMPRESSED_BYTES) { await reader.cancel(); throw new Error('Prediction reference exceeds the size limit.'); }
    chunks.push(value);
  }
  const packed = Buffer.concat(chunks);
  if (createHash('sha256').update(packed).digest('hex') !== REAL_PREDICTION_REFERENCE.compressedSha256) throw new Error('Compressed reference checksum mismatch.');
  const text = gunzipSync(packed, { maxOutputLength: MAX_FASTA_BYTES }).toString('utf8');
  await validateReferenceExample(text);
  if (localCache) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, text, 'utf8');
  }
  return text;
}

export function loadPredictionReference() {
  pending ??= loadReference().finally(() => { pending = undefined; });
  return pending;
}
