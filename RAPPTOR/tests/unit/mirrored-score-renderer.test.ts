import { describe, expect, it, vi } from 'vitest';
import type { Feature, Region } from '@jbrowse/core/util';
import {
  MINUS_SCORE_COLOR,
  PLUS_SCORE_COLOR,
  buildMirroredLinePaths,
  drawMirroredScores,
  findMirroredFeature,
  mirroredFeatureScore,
  mirroredScoreY,
} from '@/features/genome-browser/plugins/mirrored-score-renderer';

function feature(id: string, source: 'plus' | 'minus', start: number, score: number, maxScore?: number) {
  const data: Record<string, unknown> = {
    uniqueId: id,
    refName: 'contig_1',
    source,
    start,
    end: start + 1,
    score,
    ...(maxScore === undefined ? {} : { summary: true, maxScore }),
  };
  return {
    id: () => id,
    get: (key: string) => data[key],
    toJSON: () => data,
  } as unknown as Feature;
}

const region = {
  assemblyName: 'GCA_test',
  refName: 'contig_1',
  start: 0,
  end: 100,
  reversed: false,
} as Region;

function mockContext() {
  const barCalls: Array<{ color: string; x: number; y: number; width: number; height: number }> = [];
  const strokeCalls: string[] = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect(this: { fillStyle: string }, x: number, y: number, width: number, height: number) {
      barCalls.push({ color: this.fillStyle, x, y, width, height });
    },
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke(this: { strokeStyle: string }) { strokeCalls.push(this.strokeStyle); },
  } as unknown as CanvasRenderingContext2D;
  return { context, barCalls, strokeCalls };
}

describe('mirrored raw-score renderer', () => {
  it('keeps the established biological strand palette', () => {
    expect(PLUS_SCORE_COLOR).toBe('#0f766e');
    expect(MINUS_SCORE_COLOR).toBe('#be123c');
  });

  it('draws plus scores above and minus scores below the central baseline', () => {
    const plus = feature('plus', 'plus', 10, 0.8);
    const minus = feature('minus', 'minus', 20, 0.6);
    const { context, barCalls } = mockContext();
    drawMirroredScores(context, {
      bpPerPx: 1,
      features: new Map([[plus.id(), plus], [minus.id(), minus]]),
      height: 180,
      regions: [region],
    }, 'bars');

    expect(barCalls).toHaveLength(2);
    expect(barCalls[0]).toMatchObject({ color: PLUS_SCORE_COLOR, y: 18, height: 72 });
    expect(barCalls[1]).toMatchObject({ color: MINUS_SCORE_COLOR, y: 90, height: 54 });
    expect(mirroredScoreY(1, '+')).toBe(0);
    expect(mirroredScoreY(1, '-')).toBe(180);
  });

  it('uses maxScore for zoomed summaries in bars and whole-view lines', () => {
    const plus = feature('summary-plus', 'plus', 10, 0.2, 0.9);
    const minus = feature('summary-minus', 'minus', 20, 0.1, 0.7);
    const features = new Map([[plus.id(), plus], [minus.id(), minus]]);
    expect(mirroredFeatureScore(plus)).toBe(0.9);
    expect(mirroredFeatureScore(minus)).toBe(0.7);

    const bars = mockContext();
    drawMirroredScores(bars.context, { bpPerPx: 1, features, height: 180, regions: [region] }, 'bars');
    expect(bars.barCalls[0].height).toBe(81);
    expect(bars.barCalls[1].height).toBeCloseTo(63);

    const lines = mockContext();
    drawMirroredScores(lines.context, { bpPerPx: 1, features, height: 180, regions: [region] }, 'lines');
    expect(lines.strokeCalls).toEqual([]);

    const paths = buildMirroredLinePaths(features.values(), (_refName, coordinate) => coordinate);
    expect(paths).toEqual([
      expect.objectContaining({ color: PLUS_SCORE_COLOR, d: 'M10.5,9', strand: '+' }),
      expect.objectContaining({ color: MINUS_SCORE_COLOR, d: 'M20.5,153', strand: '-' }),
    ]);
  });

  it('connects score points loaded from separate tiles in one continuous path', () => {
    const tile1 = [feature('plus-1', 'plus', 0, 0.2), feature('plus-2', 'plus', 50, 0.4)];
    const tile2 = [feature('plus-3', 'plus', 100, 0.7), feature('plus-4', 'plus', 150, 0.5)];

    const [path] = buildMirroredLinePaths([...tile1, ...tile2], (_refName, coordinate) => coordinate);

    expect(path.d).toBe('M0.5,72L50.5,54L100.5,27L150.5,45');
    expect(path.d.match(/M/g)).toHaveLength(1);
    expect(path.d.match(/L/g)).toHaveLength(3);
  });

  it('sorts by screen position so reversed views stay continuous without swapping colors', () => {
    const plus = feature('plus', 'plus', 10, 0.8);
    const minus = feature('minus', 'minus', 20, 0.6);
    const paths = buildMirroredLinePaths(
      [plus, minus, feature('plus-2', 'plus', 30, 0.4)],
      (_refName, coordinate) => 100 - coordinate,
    );

    expect(paths.find((path) => path.strand === '+')).toMatchObject({
      color: PLUS_SCORE_COLOR,
      d: 'M69.5,54L89.5,18',
    });
    expect(paths.find((path) => path.strand === '-')).toMatchObject({
      color: MINUS_SCORE_COLOR,
      d: 'M79.5,144',
    });
  });

  it('uses x and y together for hover while keeping minus scores positive', () => {
    const plus = feature('plus', 'plus', 10, 0.85);
    const minus = feature('minus', 'minus', 10, 0.75);
    const features = [plus, minus];
    expect(findMirroredFeature(features, region, 1, 100, 180, 10.5, 30)?.id()).toBe('plus');
    expect(findMirroredFeature(features, region, 1, 100, 180, 10.5, 150)?.id()).toBe('minus');
    expect(mirroredFeatureScore(minus)).toBe(0.75);
  });
});
