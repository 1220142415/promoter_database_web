import { describe, expect, it, vi } from 'vitest';
import { readSmoothedScores, smoothScoreIntervals, type ScoreInterval } from '@/features/genome-browser/score-smoothing';

const intervals = (values: number[], offset = 0) => values.map((score, i) => ({ start: offset + i, end: offset + i + 1, score }));
const smooth = (values: number[]) => [...smoothScoreIntervals(intervals(values), 0, values.length)].map(row => row.score);
const collect = async (rows: AsyncIterable<ScoreInterval>) => { const result = []; for await (const row of rows) result.push(row); return result; };

describe('Gaussian score track smoothing', () => {
  it('matches SciPy sigma=1 reflect values, including both ends', () => {
    const expected = [0.42704095, 1.06782203, 2, 2.93217797, 3.57295905];
    smooth([0, 1, 2, 3, 4]).forEach((score, i) => expect(score).toBeCloseTo(expected[i], 7));
    expect(smooth([.75])[0]).toBeCloseTo(.75, 14);
    expect(smooth([])).toEqual([]);
  });

  it('treats each strand independently and preserves reverse orientation symmetry', () => {
    const plus = [0, .1, .3, .99, .7, .05, 0];
    const minus = [1, .2, 0, 0, .2, .1, .4];
    const reversed = smooth([...plus].reverse()).reverse();
    smooth(plus).forEach((score, i) => expect(score).toBeCloseTo(reversed[i], 14));
    expect(smooth(plus)).not.toEqual(smooth(minus));
    expect(smooth(plus)[3]).toBeLessThan(.99);
  });

  it('does not fill gaps or mix separate covered runs', () => {
    const raw = [...intervals([1, 1]), ...intervals([0, 0], 10)];
    const result = [...smoothScoreIntervals(raw, 0, 20)];
    expect(result.map(row => row.start)).toEqual([0, 1, 10, 11]);
    expect(result[0].score).toBeCloseTo(1, 14);
    expect(result[2].score).toBe(0);
  });

  it('keeps all scores, does not mutate input, and rejects malformed/summary data', () => {
    const raw = intervals([.01, .02, .01]);
    const before = structuredClone(raw);
    expect([...smoothScoreIntervals(raw, 0, 3)]).toHaveLength(3);
    expect(raw).toEqual(before);
    for (const invalid of [[{ start: 0, end: 10, score: 1 }], intervals([NaN]), intervals([1, 2]).reverse()]) {
      expect(() => [...smoothScoreIntervals(invalid, 0, 100)]).toThrow('full-resolution');
    }
  });

  it('is stable across viewport and chunk boundaries, even when a run starts near an edge', async () => {
    const raw = intervals(Array.from({ length: 107 }, (_, i) => ((i * 17) % 31) / 31), 79);
    const read = vi.fn(async (start, end) => raw.filter(row => row.start >= start && row.start < end));
    const expected = [...smoothScoreIntervals(raw, 81, 181)];
    const actual = await collect(readSmoothedScores(read, 81, 181, { chunkSize: 13 }));
    expect(actual).toEqual(expected);
    expect(read).toHaveBeenCalledWith(77, 98);
    expect(await collect(readSmoothedScores(read, 93, 147, { chunkSize: 7 }))).toEqual(expected.filter(row => row.start >= 93 && row.start < 147));
  });

  it('takes bin maxima after smoothing and preserves gaps at low zoom', async () => {
    const raw = [...intervals([0, 0, 1, 0, 0]), ...intervals([.2, .4], 10)];
    const result = await collect(readSmoothedScores(async (start, end) => raw.filter(row => row.start >= start && row.start < end), 0, 12, { binSize: 20, chunkSize: 3 }));
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ start: 0, end: 5 });
    expect(result[0].score).toBeCloseTo(smooth([0, 0, 1, 0, 0])[2], 14);
    expect(result[1]).toMatchObject({ start: 10, end: 12 });
  });

  it('propagates download and cancellation failures instead of showing an empty track', async () => {
    await expect(collect(readSmoothedScores(async () => { throw Error('HTTP 403'); }, 0, 20))).rejects.toThrow('HTTP 403');
    const read = vi.fn();
    await expect(collect(readSmoothedScores(read, 0, 20, { checkCancelled: () => { throw Error('Aborted'); } }))).rejects.toThrow('Aborted');
    expect(read).not.toHaveBeenCalled();
  });
});
