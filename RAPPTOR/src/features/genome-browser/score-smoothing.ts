export interface ScoreInterval { start: number; end: number; score: number }

// scipy.ndimage.gaussian_filter1d(sigma=1, mode='reflect', truncate=4).
export const SMOOTHING_RADIUS = 4;
const weights = Array.from({ length: 9 }, (_, i) => Math.exp(-0.5 * (i - 4) ** 2));
const total = weights.reduce((sum, weight) => sum + weight, 0);
const kernel = weights.map(weight => weight / total);

function reflect(index: number, length: number) {
  const wrapped = ((index % (2 * length)) + 2 * length) % (2 * length);
  return wrapped < length ? wrapped : 2 * length - 1 - wrapped;
}

/** Input is full-resolution, ascending, single-strand data with a 4 bp halo. */
export function* smoothScoreIntervals(raw: readonly ScoreInterval[], start: number, end: number): Generator<ScoreInterval> {
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!Number.isInteger(row.start) || row.end !== row.start + 1 || !Number.isFinite(row.score)
      || (i > 0 && row.start < raw[i - 1].end)) {
      throw new Error('Score smoothing requires ordered, full-resolution 1 bp scores.');
    }
  }
  // Missing anchors are not zeroes. Reflect separately at each covered run.
  for (let first = 0; first < raw.length;) {
    let stop = first + 1;
    while (stop < raw.length && raw[stop].start === raw[stop - 1].end) stop++;
    for (let i = first; i < stop; i++) {
      if (raw[i].start < start || raw[i].start >= end) continue;
      let score = 0;
      for (let offset = -4; offset <= 4; offset++) {
        score += raw[first + reflect(i - first + offset, stop - first)].score * kernel[offset + 4];
      }
      yield { start: raw[i].start, end: raw[i].end, score };
    }
    first = stop;
  }
}

/** Bound memory even at chromosome scale; aggregate only AFTER smoothing. */
export async function* readSmoothedScores(
  read: (start: number, end: number) => Promise<ScoreInterval[]>,
  start: number,
  end: number,
  { binSize = 1, chunkSize = 65_536, checkCancelled = () => {} } = {},
): AsyncGenerator<ScoreInterval> {
  let bin: ScoreInterval | undefined;
  for (let left = start; left < end; left += chunkSize) {
    checkCancelled();
    const right = Math.min(end, left + chunkSize);
    const raw = await read(Math.max(0, left - SMOOTHING_RADIUS), right + SMOOTHING_RADIUS);
    checkCancelled();
    for (const row of smoothScoreIntervals(raw, left, right)) {
      if (bin && bin.end === row.start && Math.floor(bin.start / binSize) === Math.floor(row.start / binSize)) {
        bin.end = row.end;
        bin.score = Math.max(bin.score, row.score);
      } else {
        if (bin) yield bin;
        bin = { ...row };
      }
    }
  }
  if (bin) yield bin;
}
