'use client';

import { useRef } from 'react';
import { PrerenderedCanvas } from '@jbrowse/core/ui';
import { featureSpanPx, type Feature, type Region } from '@jbrowse/core/util';
import { checkStopToken } from '@jbrowse/core/util/stopToken';
import { WiggleBaseRenderer } from '@jbrowse/plugin-wiggle';

export const MIRRORED_SCORE_HEIGHT = 180;
export const PLUS_SCORE_COLOR = '#0f766e';
export const MINUS_SCORE_COLOR = '#be123c';

export type MirroredScoreMode = 'bars' | 'lines';

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
  } else {
    for (const strand of ['+', '-'] as const) {
      const byContig = new Map<string, Array<{ feature: Feature; x: number }>>();
      for (const feature of byStrand[strand]) {
        const [leftPx, rightPx] = featureSpanPx(feature, region, bpPerPx);
        const refName = String(feature.get('refName') || region.refName);
        const group = byContig.get(refName) || [];
        group.push({ feature, x: (leftPx + rightPx) / 2 });
        byContig.set(refName, group);
      }
      for (const ordered of byContig.values()) {
        ordered.sort((a, b) => a.x - b.x);
        if (!ordered.length) continue;
        ctx.beginPath();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = strand === '+' ? PLUS_SCORE_COLOR : MINUS_SCORE_COLOR;
        ordered.forEach(({ feature, x }, index) => {
          const y = mirroredScoreY(mirroredFeatureScore(feature), strand, height);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
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
