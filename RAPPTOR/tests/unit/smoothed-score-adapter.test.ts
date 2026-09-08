import { firstValueFrom, toArray } from 'rxjs';
import { expect, it, vi } from 'vitest';
import { SmoothedBigWigAdapter, smoothedScoreConfig } from '@/features/genome-browser/plugins/smoothed-score-plugin';

const region = { refName: 'contig_2', start: 100, end: 110, assemblyName: 'test' };
const headers = { Authorization: 'test-only' };
function fixture() {
  const adapter = new SmoothedBigWigAdapter(smoothedScoreConfig.create({ source: 'minus', bigWigLocation: { uri: '/scores.minus.bw' } }));
  const getFeatures = vi.fn(async () => Array.from({ length: 18 }, (_, i) => ({ start: 96 + i, end: 97 + i, score: i === 9 ? 1 : 0 })));
  vi.spyOn(adapter, 'setup').mockResolvedValue({ bigwig: { getFeatures }, header: {
    refsByName: { contig_2: 0 }, refsByNumber: { 0: { length: 200 } },
  } } as never);
  return { adapter, getFeatures };
}

it('uses raw resolution and a halo at low zoom, preserves request authorization, and labels the strand', async () => {
  const { adapter, getFeatures } = fixture();
  const signal = new AbortController().signal;
  const features = await firstValueFrom(adapter.getFeatures(region, { bpPerPx: 1000, headers, signal }).pipe(toArray()));
  expect(getFeatures).toHaveBeenCalledWith('contig_2', 96, 114, expect.objectContaining({ basesPerSpan: 0, scale: Infinity, headers, signal }));
  expect(features).toHaveLength(1);
  expect(features[0].get('source')).toBe('minus');
  expect(features[0].get('score')).toBeCloseTo(0.39894346935609776, 12);
  expect(features[0].toJSON()).toMatchObject({ refName: 'contig_2', start: 100, end: 110 });
});

it('propagates artifact errors rather than completing an empty successful stream', async () => {
  const { adapter, getFeatures } = fixture();
  getFeatures.mockRejectedValueOnce(Error('HTTP 403'));
  await expect(firstValueFrom(adapter.getFeatures(region).pipe(toArray()))).rejects.toThrow('HTTP 403');
});
