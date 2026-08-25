'use client';

import { useRef } from 'react';
import { PrerenderedCanvas } from '@jbrowse/core/ui';
import { featureSpanPx, type Feature, type Region } from '@jbrowse/core/util';
import { checkStopToken } from '@jbrowse/core/util/stopToken';
import { WiggleBaseRenderer } from '@jbrowse/plugin-wiggle';

export const MIRRORED_SCORE_HEIGHT = 180;
// Keep the original RAPPTOR score palette.  Strand glyphs use this same
// biological mapping; reversing the view must never swap these colors.
export const PLUS_SCORE_COLOR = '#0f766e';
export const MINUS_SCORE_COLOR = '#be123c';

export type MirroredScoreMode = 'bars' | 'lines';

export type MirroredLinePath = {
  color: string;
  d: string;
  refName: string;
  strand: '+' | '-';
};

type ScoreFeature = Pick<Feature, 'get' | 'id'>;

type MirroredRenderProps = {
  bpPerPx: number;
  features: Map<string, Feature>;
  height: number;
  regions: Region[];
  stopToken?: string;
};

type MirroredRenderingProps = MirroredRenderProps & {
  blockKey: string;
  width: number;
  highResolutionScaling?: number;
  imageData?: ImageData;
  onMouseLeave?: (event: React.MouseEvent) => void;
  onMouseMove?: (event: React.MouseEvent, featureId?: string) => void;
  onFeatureClick?: (event: React.MouseEvent, featureId?: string) => void;
};

function strandForSource(source: unknown) {
  return source === 'minus' ? '-' : source === 'plus' ? '+' : undefined;
}

export function mirroredFeatureScore(feature: ScoreFeature) {
  const raw = feature.get('summary') ? feature.get('maxScore') : feature.get('score');
  const score = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  return Math.max(0, Math.min(1, score));
}

export function mirroredScoreY(score: number, strand: '+' | '-', height = MIRRORED_SCORE_HEIGHT) {
  const baseline = height / 2;
  const magnitude = Math.max(0, Math.min(1, score)) * baseline;
  return strand === '+' ? baseline - magnitude : baseline + magnitude;
}

export function buildMirroredLinePaths(
  features: Iterable<Feature>,
  coordinateToPx: (refName: string, coordinate: number) => number | undefined,
  height = MIRRORED_SCORE_HEIGHT,
) {
  const grouped = new Map<string, Array<{ x: number; y: number }>>();
  const svgNumber = (value: number) => Number(value.toFixed(6));

  for (const feature of features) {
    const strand = strandForSource(feature.get('source'));
    const start = Number(feature.get('start'));
    const end = Number(feature.get('end'));
    if (!strand || !Number.isFinite(start) || !Number.isFinite(end)) continue;

    const refName = String(feature.get('refName') || '');
    if (!refName) continue;
    const x = coordinateToPx(refName, (start + end) / 2);
    if (x === undefined || !Number.isFinite(x)) continue;

    const key = `${refName}\u0000${strand}`;
    const points = grouped.get(key) || [];
    points.push({ x, y: mirroredScoreY(mirroredFeatureScore(feature), strand, height) });
    grouped.set(key, points);
  }

  const paths: MirroredLinePath[] = [];
  for (const [key, points] of grouped) {
    const separator = key.lastIndexOf('\u0000');
    const refName = key.slice(0, separator);
    const strand = key.slice(separator + 1) as '+' | '-';
    points.sort((a, b) => a.x - b.x);
    if (!points.length) continue;
    paths.push({
      color: strand === '+' ? PLUS_SCORE_COLOR : MINUS_SCORE_COLOR,
      d: points
        .map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${svgNumber(x)},${svgNumber(y)}`)
        .join(''),
      refName,
      strand,
    });
  }

  return paths;
}

export function findMirroredFeature(
  features: Iterable<Feature>,
  region: Region,
  bpPerPx: number,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
) {
  const strand = offsetY < height / 2 ? '+' : '-';
  const source = strand === '+' ? 'plus' : 'minus';
  const px = region.reversed ? width - offsetX : offsetX;
  const clientBp = region.start + bpPerPx * px;
  const tolerance = Math.max(bpPerPx * 3, 1);
  let best: Feature | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const feature of features) {
    if (feature.get('source') !== source) continue;
    const start = Number(feature.get('start'));
    const end = Number(feature.get('end'));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (clientBp < start - tolerance || clientBp > end + tolerance) continue;
    const distance = Math.abs(clientBp - (start + end) / 2);
    if (distance < bestDistance) {
      best = feature;
      bestDistance = distance;
    }
  }
  return best;
}

export function drawMirroredScores(
  ctx: CanvasRenderingContext2D,
  props: MirroredRenderProps,
  mode: MirroredScoreMode,
) {
  const { bpPerPx, features, height, regions, stopToken } = props;
  const region = regions[0];
  const baseline = height / 2;
  const byStrand: Record<'+' | '-', Feature[]> = { '+': [], '-': [] };
  const reducedFeatures: Feature[] = [];
  let lastStopCheck = performance.now();

  for (const feature of features.values()) {
    if (performance.now() - lastStopCheck > 400) {
      if (stopToken) checkStopToken(stopToken);
      lastStopCheck = performance.now();
    }
    const strand = strandForSource(feature.get('source'));
    if (!strand) continue;
    byStrand[strand].push(feature);
    reducedFeatures.push(feature);
  }

  if (mode === 'bars') {
    for (const strand of ['+', '-'] as const) {
      ctx.fillStyle = strand === '+' ? PLUS_SCORE_COLOR : MINUS_SCORE_COLOR;
      for (const feature of byStrand[strand]) {
        const [leftPx, rightPx] = featureSpanPx(feature, region, bpPerPx);
        const y = mirroredScoreY(mirroredFeatureScore(feature), strand, height);
        const top = Math.min(y, baseline);
        const barHeight = Math.max(1, Math.abs(y - baseline));
        ctx.fillRect(leftPx, top, Math.max(1, rightPx - leftPx + 0.3), barHeight);
      }
    }
  }

  return { reducedFeatures };
}

export function MirroredScoreRendering(props: MirroredRenderingProps) {
  const {
    regions,
    features,
    bpPerPx,
    width,
    height,
    onMouseLeave,
    onMouseMove,
    onFeatureClick,
  } = props;
  const region = regions[0];
  const ref = useRef<HTMLDivElement>(null);

  const featureAtEvent = (event: React.MouseEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return undefined;
    return findMirroredFeature(
      features.values(),
      region,
      bpPerPx,
      width,
      height,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };

  return (
    <div
      ref={ref}
      data-testid="mirrored-score-rendering"
      onMouseMove={(event) => onMouseMove?.(event, featureAtEvent(event)?.id())}
      onClick={(event) => onFeatureClick?.(event, featureAtEvent(event)?.id())}
      onMouseLeave={(event) => onMouseLeave?.(event)}
      style={{ overflow: 'visible', position: 'relative', height }}
    >
      <PrerenderedCanvas {...props} />
    </div>
  );
}

abstract class MirroredScoreRenderer extends WiggleBaseRenderer {
  abstract mode: MirroredScoreMode;

  async draw(ctx: CanvasRenderingContext2D, props: MirroredRenderProps) {
    return drawMirroredScores(ctx, props, this.mode);
  }
}

export class MirroredBarsRenderer extends MirroredScoreRenderer {
  mode = 'bars' as const;
}

export class MirroredLinesRenderer extends MirroredScoreRenderer {
  mode = 'lines' as const;
}
