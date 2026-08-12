import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accessionShard, alignPackOffset, logicalObjectPrefix, PACK_ALIGNMENT } from '@/lib/storage-layout';
import { accessionShard as scriptAccessionShard } from '../../scripts/lib/storage-layout.mjs';
import { planShardPacks } from '../../scripts/build-packed-release.mjs';

describe('packed release layout', () => {
  it('uses the first two SHA-256 hex characters as a stable shard', () => {
    const accession = 'GCA_000411415.1';
    const expected = createHash('sha256').update(accession, 'utf8').digest('hex').slice(0, 2);
    expect(accessionShard(accession)).toBe(expected);
    expect(scriptAccessionShard(accession)).toBe(expected);
    expect(logicalObjectPrefix(accession)).toBe(expected + '/' + accession);
  });

  it('aligns logical assets and starts a new pack before the target is exceeded', () => {
    const entries = [
      { accession: 'GCA_000000001.1', file: 'a', shard: '00', bytes: 3, sha256: 'a' },
      { accession: 'GCA_000000002.1', file: 'b', shard: '00', bytes: 5, sha256: 'b' },
      { accession: 'GCA_000000003.1', file: 'c', shard: '00', bytes: 7, sha256: 'c' },
    ];
    const packs = planShardPacks(entries, { releaseId: '2026-08-11', targetBytes: PACK_ALIGNMENT + 6, maxBytes: PACK_ALIGNMENT * 3 });
    expect(packs).toHaveLength(2);
    expect(packs[0].entries.map((entry) => entry.offset)).toEqual([0, PACK_ALIGNMENT]);
    expect(packs[1].entries[0].offset).toBe(0);
    expect(packs[0].path).toBe('releases/2026-08-11/packs/pack-00-000.bin');
  });

  it('plans 80,000 genomes without offset overlap or unsafe pack sizes', () => {
    const entries = Array.from({ length: 80_000 }, (_, index) => ({
      accession: 'GCA_' + String(index + 1).padStart(9, '0') + '.1',
      file: 'reference.fa.gz',
      shard: '7f',
      bytes: 1_500_000,
      sha256: String(index).padStart(64, '0'),
    }));
    const packs = planShardPacks(entries, { releaseId: 'synthetic' });
    expect(packs.length).toBeGreaterThan(200);
    for (const pack of packs) {
      expect(pack.bytes).toBeLessThanOrEqual(512 * 1024 * 1024);
      for (let index = 1; index < pack.entries.length; index += 1) {
        const previous = pack.entries[index - 1];
        const current = pack.entries[index];
        expect(current.offset).toBeGreaterThanOrEqual(previous.offset + previous.bytes);
        expect(current.offset % PACK_ALIGNMENT).toBe(0);
      }
    }
  });

  it('rejects invalid alignment inputs', () => {
    expect(() => alignPackOffset(-1)).toThrow();
    expect(() => alignPackOffset(10, 0)).toThrow();
  });
});
