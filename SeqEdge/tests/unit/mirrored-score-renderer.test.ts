import { describe, expect, it, vi } from 'vitest';
import type { Feature, Region } from '@jbrowse/core/util';
import {
  MINUS_SCORE_COLOR,
  PLUS_SCORE_COLOR,
  drawMirroredScores,
  findMirroredFeature,
  mirroredFeatureScore,
  mirroredScoreY,
} from '@/jbrowse/mirrored-score-renderer';

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

  it('uses maxScore for zoomed summaries in both bars and lines', () => {
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
    expect(lines.strokeCalls).toEqual([PLUS_SCORE_COLOR, MINUS_SCORE_COLOR]);
    expect(vi.mocked(lines.context.moveTo).mock.calls[0][1]).toBe(9);
    expect(vi.mocked(lines.context.moveTo).mock.calls[1][1]).toBeCloseTo(153);
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
