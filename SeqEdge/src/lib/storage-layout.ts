import { createHash } from 'node:crypto';

export const PACK_ALIGNMENT = 4_096;
export const PACK_TARGET_BYTES = 512 * 1024 * 1024;
export const PACK_MAX_BYTES = 1024 * 1024 * 1024;

export function accessionShard(accession: string) {
  return createHash('sha256').update(accession, 'utf8').digest('hex').slice(0, 2);
}

export function logicalObjectPrefix(accession: string) {
  return `${accessionShard(accession)}/${accession}`;
}

export function alignPackOffset(value: number, alignment = PACK_ALIGNMENT) {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(alignment) || alignment <= 0) {
    throw new Error('Pack offsets and alignment must be non-negative safe integers.');
  }
  return Math.ceil(value / alignment) * alignment;
}
