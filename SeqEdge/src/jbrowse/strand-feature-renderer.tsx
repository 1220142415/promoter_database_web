'use client';

import { useEffect, useRef, useState } from 'react';
import { bpToPx, measureText, type Feature, type Region } from '@jbrowse/core/util';
import { GranularRectLayout } from '@jbrowse/core/util/layouts';
import { observer } from 'mobx-react';

// Color always encodes the biological strand.  Reversing a JBrowse view only
// changes the screen direction of the glyph, never this mapping.
export const PLUS_STRAND_COLOR = '#0f766e';
export const MINUS_STRAND_COLOR = '#be123c';
export const UNKNOWN_STRAND_COLOR = '#64748b';
export const PROMOTER_GLYPH_HEIGHT = 24;
export const PROMOTER_BODY_MIN_WIDTH = 12;
export const PROMOTER_FLAG_POLE_HEIGHT = 12;
export const PROMOTER_FLAG_LENGTH = 6;
export const MIN_FEATURE_PIXEL_WIDTH = 3;
export const FEATURE_ARROW_LENGTH = 6;
export const SVG_HEIGHT_PADDING = 2;
export const ANNOTATION_JOINT_LANE_HEIGHT = 24;
export const ANNOTATION_JOINT_GAP = 4;
const ARROW_COLOR = '#1f2937';
const PROMOTER_FLAG_TOP_OFFSET = 4;
const PROMOTER_FLAG_HALF_HEIGHT = 3;
const PROMOTER_BODY_TOP_OFFSET = 14;
const PROMOTER_BODY_HEIGHT = 5;
const PROMOTER_FLAG_HIT_PADDING = 1;
const ANNOTATION_LABEL_MARGIN = 2;

export type NormalizedStrand = -1 | 0 | 1;
type LayoutRect = [number, number, number, number];

type FeatureLayout = {
  addRect: (id: string, left: number, right: number, height: number, data?: unknown) => number | null;
  getByCoord?: (x: number, y: number) => string | undefined;
  getDataByID?: (id: string) => unknown;
  getByID?: (id: string) => LayoutRect | undefined;
  getTotalHeight: () => number;
};

type DisplayModel = {
  contextMenuFeature?: Feature;
  featureUnderMouse?: Feature;
  featureIdUnderMouse?: string;
  selectedFeatureId?: string;
  getFeatureByID?: (blockKey: string, featureId: string) => LayoutRect;
  getFeatureOverlapping?: (blockKey: string, bp: number, y: number) => string | undefined;
};

type StrandRendererProps = {
  blockKey: string;
  bpPerPx: number;
  config: unknown;
  displayModel?: DisplayModel;
  exportSVG?: boolean;
  features: Map<string, Feature>;
  layout: FeatureLayout;
  regions: Region[];
  onClick?: (event: React.MouseEvent) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onMouseDown?: (event: React.MouseEvent) => void;
  onMouseEnter?: (event: React.MouseEvent) => void;
  onMouseLeave?: (event: React.MouseEvent) => void;
  onMouseMove?: (event: React.MouseEvent, featureId?: string) => void;
  onMouseOut?: (event: React.MouseEvent) => void;
  onMouseOver?: (event: React.MouseEvent) => void;
  onMouseUp?: (event: React.MouseEvent) => void;
  onFeatureClick?: (event: React.MouseEvent, featureId?: string) => void;
  onFeatureContextMenu?: (event: React.MouseEvent, featureId?: string) => void;
  [key: string]: unknown;
};

export function normalizeStrand(value: unknown): NormalizedStrand {
  if (value === 1 || value === '+' || value === '1') return 1;
  if (value === -1 || value === '-' || value === '-1') return -1;
  return 0;
}

export function strandColor(value: unknown) {
  const strand = normalizeStrand(value);
  return strand === 1 ? PLUS_STRAND_COLOR : strand === -1 ? MINUS_STRAND_COLOR : UNKNOWN_STRAND_COLOR;
}

export function strandLabel(value: unknown) {
  const strand = normalizeStrand(value);
  return strand === 1 ? '+' : strand === -1 ? '-' : 'unknown';
}

export function screenDirection(value: unknown, reversed = false): NormalizedStrand {
  const strand = normalizeStrand(value);
  return (reversed ? -strand : strand) as NormalizedStrand;
}

export function shouldShowPromoterBody(width: number) {
  return width >= PROMOTER_BODY_MIN_WIDTH;
}

export function isFormalPromoter(feature: Feature) {
  const type = String(feature.get('type') || '').toLowerCase();
  const { start, end } = featureCoordinates(feature);
  return type === 'promoter' && end - start === 100;
}

function featureCoordinates(feature: Feature) {
  const start = Number(feature.get('start'));
  const end = Number(feature.get('end'));
  return {
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : 0,
  };
}

export function promoterAnchorCoordinate(feature: Feature) {
  const { start, end } = featureCoordinates(feature);
  const strand = normalizeStrand(feature.get('strand'));
  if (strand === 1) return start + 80;
  if (strand === -1) return end - 79;
  return Math.floor((start + end) / 2) + 1;
}

export function promoterAnchorPosition(feature: Feature) {
  return promoterAnchorCoordinate(feature) - 0.5;
}

export function isRegionFeature(feature: Feature) {
  return String(feature.get('type') || '').toLowerCase() === 'region';
}

export function visibleAnnotationFeatures(features: Map<string, Feature>) {
  return [...features.values()].filter((feature) => !isRegionFeature(feature));
}

function featureAtEvent(event: React.MouseEvent, element: SVGSVGElement | null, props: StrandRendererProps, width: number) {
  const { blockKey, bpPerPx, displayModel, regions } = props;
  const region = regions[0];
  const directFeatureId = event.target instanceof Element
    ? event.target.closest('[data-direct-feature-id]')?.getAttribute('data-direct-feature-id')
    : undefined;
  if (directFeatureId) return directFeatureId;
  if (!element || !displayModel?.getFeatureOverlapping) return undefined;
  const rect = element.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  const visibleOffsetX = Math.max(0, Math.min(width, offsetX));
  const px = region.reversed ? width - visibleOffsetX : visibleOffsetX;
  const layoutId = displayModel.getFeatureOverlapping(blockKey, region.start + bpPerPx * px, offsetY);
  if (!layoutId) return undefined;
  const layoutData = props.layout.getDataByID?.(layoutId) as { featureId?: unknown } | undefined;
  return typeof layoutData?.featureId === 'string' ? layoutData.featureId : layoutId;
}

function screenInterval(feature: Feature, region: Region, bpPerPx: number) {
  const { start, end } = featureCoordinates(feature);
  const rawStartPx = bpToPx(start, region, bpPerPx);
  const rawEndPx = bpToPx(end, region, bpPerPx);
  const viewportWidth = (region.end - region.start) / bpPerPx;
  const rawLeft = Math.min(rawStartPx, rawEndPx);
  const rawRight = Math.max(rawStartPx, rawEndPx);
  const left = Math.max(0, Math.min(viewportWidth, rawLeft));
  const right = Math.max(0, Math.min(viewportWidth, rawRight));
  const projectedWidth = Math.max(0, right - left);
  const visualWidth = Math.max(MIN_FEATURE_PIXEL_WIDTH, projectedWidth);
  const center = Math.max(0, Math.min(viewportWidth, (rawStartPx + rawEndPx) / 2));
  const visualLeft = projectedWidth >= MIN_FEATURE_PIXEL_WIDTH
    ? left
    : Math.max(0, Math.min(viewportWidth - visualWidth, center - visualWidth / 2));
  const visualRight = Math.min(viewportWidth, visualLeft + visualWidth);
  return {
    start,
    end,
    rawStartPx,
    rawEndPx,
    left: visualLeft,
    right: visualRight,
    width: Math.max(0, visualRight - visualLeft),
    viewportWidth,
    visible: rawRight > 0 && rawLeft < viewportWidth,
  };
}

function endpointInViewport(px: number, viewportWidth: number) {
  return px >= 0 && px <= viewportWidth;
}

export function promoterFlagLayoutBounds(
  start: number,
  end: number,
  anchor: number,
  strandValue: unknown,
  bpPerPx: number,
) {
  const strand = normalizeStrand(strandValue);
  const leftPixels = strand === -1 ? PROMOTER_FLAG_LENGTH : PROMOTER_FLAG_HIT_PADDING;
  const rightPixels = strand === 1 ? PROMOTER_FLAG_LENGTH : PROMOTER_FLAG_HIT_PADDING;
  return {
    start: Math.min(start, anchor - leftPixels * bpPerPx),
    end: Math.max(end, anchor + rightPixels * bpPerPx),
  };
}

function arrowEndpoint(feature: Feature, direction: NormalizedStrand, interval: ReturnType<typeof screenInterval>) {
  if (!direction) return undefined;
  // The biological arrow is at the genomic end of the feature in its strand
  // direction. Do not draw one at a clipped viewport edge.
  const strand = normalizeStrand(feature.get('strand'));
  const genomicEndpointPx = strand === 1 ? interval.rawEndPx : interval.rawStartPx;
  return endpointInViewport(genomicEndpointPx, interval.viewportWidth) ? genomicEndpointPx : undefined;
}

type ArrowPlacement = {
  tip: number;
};

function annotationArrowPlacement(
  feature: Feature,
  direction: NormalizedStrand,
  interval: ReturnType<typeof screenInterval>,
): ArrowPlacement | undefined {
  const endpoint = arrowEndpoint(feature, direction, interval);
  if (endpoint === undefined) return undefined;
  const outsideTip = endpoint + direction * FEATURE_ARROW_LENGTH;
  return {
    // Prefer an arrow beyond the biological endpoint. At an SVG boundary the
    // arrow remains inside the viewport and the colored body is shortened
    // below so the arrow never overlays it.
    tip: endpointInViewport(outsideTip, interval.viewportWidth) ? outsideTip : endpoint,
  };
}

function attachedArrow(
  tip: number,
  y: number,
  height: number,
  direction: NormalizedStrand,
  role = 'feature-arrow',
) {
  if (!direction) return null;
  const tail = tip - direction * FEATURE_ARROW_LENGTH;
  const headBase = tip - direction * FEATURE_ARROW_LENGTH / 2;
  const centerY = y + height / 2;
  const halfHeadHeight = Math.min(2.5, Math.max(2, height / 2 - 0.5));
  return <>
    <line
      data-role={role}
      x1={tail}
      x2={tip}
      y1={centerY}
      y2={centerY}
      stroke={ARROW_COLOR}
      strokeWidth="1.5"
    />
    <polygon
      data-role={`${role}-head`}
      points={`${tip},${centerY} ${headBase},${centerY - halfHeadHeight} ${headBase},${centerY + halfHeadHeight}`}
      fill={ARROW_COLOR}
    />
  </>;
}

function separateArrowFromBody(
  interval: ReturnType<typeof screenInterval>,
  direction: NormalizedStrand,
  placement?: ArrowPlacement,
) {
  if (!direction || !placement) {
    return { left: interval.left, right: interval.right, placement: undefined };
  }

  const tail = placement.tip - direction * FEATURE_ARROW_LENGTH;
  const left = direction === -1 ? Math.max(interval.left, tail) : interval.left;
  const right = direction === 1 ? Math.min(interval.right, tail) : interval.right;
  if (right - left < MIN_FEATURE_PIXEL_WIDTH) {
    return { left: interval.left, right: interval.right, placement: undefined };
  }
  return { left, right, placement };
}

function promoterFlag(anchorX: number, top: number, direction: NormalizedStrand, color: string) {
  const poleTop = top + PROMOTER_FLAG_TOP_OFFSET;
  const poleBottom = poleTop + PROMOTER_FLAG_POLE_HEIGHT;
  const flagCenter = poleTop + PROMOTER_FLAG_HALF_HEIGHT;
  const tipX = anchorX + direction * PROMOTER_FLAG_LENGTH;
  return <>
    <line
      data-role="promoter-flag-pole"
      data-anchor="80th-base"
      x1={anchorX}
      x2={anchorX}
      y1={poleTop}
      y2={poleBottom}
      stroke={ARROW_COLOR}
      strokeWidth="1.5"
    />
    {direction ? <polygon
      data-role="promoter-flag"
      points={`${anchorX},${poleTop} ${tipX},${flagCenter} ${anchorX},${poleTop + PROMOTER_FLAG_HALF_HEIGHT * 2}`}
      fill={color}
    /> : null}
  </>;
}

function renderPromoterFeature(
  feature: Feature,
  props: Pick<StrandRendererProps, 'bpPerPx' | 'displayModel' | 'layout' | 'regions'>,
) {
  const { bpPerPx, displayModel, layout, regions } = props;
  const region = regions[0];
  const id = String(feature.id());
  const { start, end } = featureCoordinates(feature);
  const strand = normalizeStrand(feature.get('strand'));
  const interval = screenInterval(feature, region, bpPerPx);
  if (!interval.visible || !interval.width) return null;
  const direction = screenDirection(strand, region.reversed);
  const color = strandColor(strand);
  const formal = isFormalPromoter(feature);
  const anchorPosition = formal ? promoterAnchorPosition(feature) : undefined;
  const anchorX = anchorPosition === undefined ? undefined : bpToPx(anchorPosition, region, bpPerPx);
  const anchorVisible = formal
    && anchorX !== undefined
    && endpointInViewport(anchorX, interval.viewportWidth);
  const showBody = !formal || shouldShowPromoterBody(interval.width);
  if (formal && !anchorVisible && !showBody) return null;

  const layoutBounds = formal && anchorVisible && anchorPosition !== undefined
    ? promoterFlagLayoutBounds(start, end, anchorPosition, strand, bpPerPx)
    : { start, end };
  const top = layout.addRect(id, layoutBounds.start, layoutBounds.end, PROMOTER_GLYPH_HEIGHT, {
    label: feature.get('name') || feature.get('id'),
    refName: feature.get('refName'),
  });
  if (top === null) return null;

  const selected = displayModel?.selectedFeatureId === id;
  const hovered = displayModel?.featureIdUnderMouse === id
    || displayModel?.featureUnderMouse?.id?.() === id;
  const bodyY = formal ? top + PROMOTER_BODY_TOP_OFFSET : top + 7;
  const bodyHeight = formal ? PROMOTER_BODY_HEIGHT : 10;
  const arrowGeometry = formal
    ? { left: interval.left, right: interval.right, placement: undefined }
    : separateArrowFromBody(interval, direction, annotationArrowPlacement(feature, direction, interval));
  const bodyRect = {
    x: arrowGeometry.left,
    y: bodyY,
    width: arrowGeometry.right - arrowGeometry.left,
    height: bodyHeight,
  };
  const flagTipX = anchorX === undefined ? undefined : anchorX + direction * PROMOTER_FLAG_LENGTH;
  const visualLeft = formal && anchorVisible && flagTipX !== undefined
    ? Math.min(showBody ? interval.left : anchorX!, anchorX!, flagTipX)
    : arrowGeometry.left;
  const visualRight = formal && anchorVisible && flagTipX !== undefined
    ? Math.max(showBody ? interval.right : anchorX!, anchorX!, flagTipX)
    : arrowGeometry.right;
  const visualTop = formal && anchorVisible ? top + PROMOTER_FLAG_TOP_OFFSET : bodyY;
  const visualBottom = formal && anchorVisible
    ? Math.max(top + PROMOTER_FLAG_TOP_OFFSET + PROMOTER_FLAG_POLE_HEIGHT, showBody ? bodyY + bodyHeight : 0)
    : bodyY + bodyHeight;

  return (
    <g
      key={id}
      data-feature-id={id}
      data-feature-type={String(feature.get('type') || 'promoter').toLowerCase()}
      data-formal-promoter={formal ? 'true' : 'false'}
      data-strand={strandLabel(strand)}
      data-screen-direction={direction}
    >
      <title>{formal ? 'Predicted promoter (100 bp); anchor at 80th base' : 'Predicted promoter peak'}</title>
      {showBody ? <rect data-role="promoter-body" {...bodyRect} fill={color} fillOpacity={1} /> : null}
      {formal && anchorVisible ? promoterFlag(anchorX!, top, direction, color) : null}
      {!formal && arrowGeometry.placement
        ? attachedArrow(arrowGeometry.placement.tip, bodyY, bodyHeight, direction, 'promoter-arrow')
        : null}
      {hovered ? <rect data-role="promoter-hover" x={visualLeft} y={visualTop} width={visualRight - visualLeft} height={visualBottom - visualTop} fill="#000000" fillOpacity="0.12" /> : null}
      {selected ? <rect data-role="promoter-selected" x={visualLeft - 1} y={visualTop - 1} width={visualRight - visualLeft + 2} height={visualBottom - visualTop + 2} fill="none" stroke="#00b8ff" strokeWidth="2" /> : null}
    </g>
  );
}

function annotationFeatureTree(feature: Feature): Feature[] {
  if (isRegionFeature(feature)) return [];
  const children = feature.get('subfeatures');
  if (!Array.isArray(children)) return [feature];
  return [feature, ...children.flatMap((child) => annotationFeatureTree(child as Feature))];
}

function featureName(feature: Feature) {
  return String(feature.get('name') || feature.get('id') || feature.get('type') || 'Feature');
}

function screenPxToBp(px: number, region: Region, bpPerPx: number) {
  return region.reversed ? region.end - px * bpPerPx : region.start + px * bpPerPx;
}

export function annotationLabelPlacement(feature: Feature, region: Region, bpPerPx: number, labelWidth: number) {
  const { start, end } = featureCoordinates(feature);
  const midpoint = (start + end) / 2;
  const visible = midpoint >= region.start && midpoint < region.end;
  if (!visible) return { visible, midpoint, x: 0, width: labelWidth, layoutStart: start, layoutEnd: end };

  const viewportWidth = (region.end - region.start) / bpPerPx;
  const centerX = bpToPx(midpoint, region, bpPerPx);
  const maximumX = Math.max(ANNOTATION_LABEL_MARGIN, viewportWidth - labelWidth - ANNOTATION_LABEL_MARGIN);
  const x = Math.max(ANNOTATION_LABEL_MARGIN, Math.min(maximumX, centerX - labelWidth / 2));
  const firstBp = screenPxToBp(x, region, bpPerPx);
  const lastBp = screenPxToBp(x + labelWidth, region, bpPerPx);
  return {
    visible,
    midpoint,
    x,
    width: labelWidth,
    layoutStart: Math.min(start, end, firstBp, lastBp),
    layoutEnd: Math.max(start, end, firstBp, lastBp),
  };
}

export function annotationLayoutId(featureId: string) {
  // GranularRectLayout caches rectangles permanently by ID. A versioned ID
  // separates this joint glyph from older body-only layouts, while remaining
  // stable across zoom and reverse-view changes so historical rectangles do
  // not accumulate in the same block layout.
  return `seqedge-annotation-joint-v2:${featureId}`;
}

function annotationArrowPlacements(tree: Feature[], region: Region, bpPerPx: number) {
  const candidates = tree.flatMap((feature, index) => {
    const strand = normalizeStrand(feature.get('strand'));
    const direction = screenDirection(strand, region.reversed);
    const interval = screenInterval(feature, region, bpPerPx);
    if (!interval.visible || !interval.width) return [];
    const placement = annotationArrowPlacement(feature, direction, interval);
    return placement ? [{ feature, direction, placement, index }] : [];
  });

  // Gene/CDS/exon records commonly share an endpoint; drawing all of them
  // produces an unreadable stack of identical black arrows.
  candidates.sort((left, right) => left.index - right.index);

  const accepted: Array<{ direction: NormalizedStrand; placement: ArrowPlacement }> = [];
  const bodyPlacements = new Map(candidates.map((candidate) => [String(candidate.feature.id()), candidate.placement]));
  const arrowPlacements = new Map<string, ArrowPlacement>();
  for (const candidate of candidates) {
    const overlaps = accepted.some((current) => (
      current.direction === candidate.direction
      && Math.abs(current.placement.tip - candidate.placement.tip) <= FEATURE_ARROW_LENGTH
    ));
    if (overlaps) continue;
    accepted.push(candidate);
    arrowPlacements.set(String(candidate.feature.id()), candidate.placement);
  }
  return { bodyPlacements, arrowPlacements };
}

export const DirectionalGlyph = observer(function DirectionalGlyph({
  feature,
  region,
  bpPerPx,
  top,
  displayModel,
  root = false,
  arrowPlacement,
  arrowOnly = false,
  bodyOnly = false,
}: {
  feature: Feature;
  region: Region;
  bpPerPx: number;
  top: number;
  displayModel?: DisplayModel;
  root?: boolean;
  arrowPlacement?: ArrowPlacement | null;
  arrowOnly?: boolean;
  bodyOnly?: boolean;
}) {
  if (isRegionFeature(feature)) return null;
  const type = String(feature.get('type') || '').toLowerCase();
  const strand = normalizeStrand(feature.get('strand'));
  const direction = screenDirection(strand, region.reversed);
  const interval = screenInterval(feature, region, bpPerPx);
  if (!interval.visible || !interval.width) return null;

  const height = root ? 10 : type === 'cds' ? 6 : 8;
  const y = top + (10 - height) / 2;
  const color = strandColor(strand);
  const id = String(feature.id());
  const selected = displayModel?.selectedFeatureId === id;
  const hovered = displayModel?.featureIdUnderMouse === id
    || displayModel?.featureUnderMouse?.id?.() === id;
  const resolvedArrowPlacement = arrowPlacement === undefined
    ? annotationArrowPlacement(feature, direction, interval)
    : arrowPlacement || undefined;
  const arrowGeometry = separateArrowFromBody(interval, direction, resolvedArrowPlacement);

  return (
    <g
      key={id}
      data-feature-id={id}
      data-feature-type={type}
      data-strand={strandLabel(strand)}
      data-screen-direction={direction}
      data-arrow-overlay={arrowOnly ? 'true' : undefined}
    >
      {!arrowOnly ? <rect data-role="feature-body" x={arrowGeometry.left} y={y} width={arrowGeometry.right - arrowGeometry.left} height={height} fill={color} /> : null}
      {!bodyOnly && arrowGeometry.placement
        ? attachedArrow(arrowGeometry.placement.tip, y, height, direction, 'feature-arrow')
        : null}
      {!arrowOnly && hovered ? <rect data-role="feature-hover" x={arrowGeometry.left} y={y} width={arrowGeometry.right - arrowGeometry.left} height={height} fill="#000000" fillOpacity="0.12" /> : null}
      {!arrowOnly && selected ? <rect data-role="feature-selected" x={arrowGeometry.left - 1} y={y - 1} width={arrowGeometry.right - arrowGeometry.left + 2} height={height + 2} fill="none" stroke="#00b8ff" strokeWidth="2" /> : null}
    </g>
  );
});

function renderAnnotationFeature(
  feature: Feature,
  props: Pick<StrandRendererProps, 'bpPerPx' | 'displayModel' | 'regions'>,
  top: number,
  labelPlacement: ReturnType<typeof annotationLabelPlacement>,
  layoutId: string,
) {
  const { bpPerPx, displayModel, regions } = props;
  const region = regions[0];
  const id = String(feature.id());
  const label = featureName(feature);

  const tree = annotationFeatureTree(feature);
  const { bodyPlacements, arrowPlacements } = annotationArrowPlacements(tree, region, bpPerPx);

  return (
    <g key={id} data-annotation-root={id} data-layout-id={layoutId} data-direct-feature-id={id}>
      {tree.map((part, index) => (
        <DirectionalGlyph
          key={String(part.id())}
          feature={part}
          region={region}
          bpPerPx={bpPerPx}
          top={top}
          displayModel={displayModel}
          root={index === 0}
          arrowPlacement={bodyPlacements.get(String(part.id())) || null}
          bodyOnly
        />
      ))}
      {tree.map((part, index) => {
        const placement = arrowPlacements.get(String(part.id()));
        return placement ? <DirectionalGlyph
          key={`${String(part.id())}:arrow`}
          feature={part}
          region={region}
          bpPerPx={bpPerPx}
          top={top}
          root={index === 0}
          arrowPlacement={placement}
          arrowOnly
        /> : null;
      })}
      {labelPlacement.visible ? <text
        data-role="annotation-label"
        data-feature-id={id}
        data-direct-feature-id={id}
        x={labelPlacement.x}
        y={top + 22}
        fontSize="11"
        fill="#111827"
      >{label}</text> : null}
    </g>
  );
}

const FeatureSvgWrapper = observer(function FeatureSvgWrapper({ children, minimumHeight, testId, ...props }: StrandRendererProps & {
  children: React.ReactNode;
  contentHeight?: number;
  minimumHeight: number;
  testId: string;
}) {
  const {
    bpPerPx,
    contentHeight,
    layout,
    regions,
    onClick,
    onContextMenu,
    onFeatureClick,
    onFeatureContextMenu,
    onMouseDown,
    onMouseEnter,
    onMouseLeave,
    onMouseMove,
    onMouseOut,
    onMouseOver,
    onMouseUp,
  } = props;
  const region = regions[0];
  const width = (region.end - region.start) / bpPerPx;
  const ref = useRef<SVGSVGElement>(null);
  const [mouseIsDown, setMouseIsDown] = useState(false);
  const resolvedHeight = Math.max(minimumHeight, contentHeight ?? layout.getTotalHeight());
  const [height, setHeight] = useState(resolvedHeight);
  const [movedDuringLastMouseDown, setMovedDuringLastMouseDown] = useState(false);
  const [initialMousePos, setInitialMousePos] = useState<{ x: number; y: number }>();

  useEffect(() => setHeight(resolvedHeight), [resolvedHeight]);
  const featureId = (event: React.MouseEvent) => featureAtEvent(event, ref.current, props, width);

  return (
    <svg
      ref={ref}
      data-testid={testId}
      width={width}
      height={height + SVG_HEIGHT_PADDING}
      style={{ display: 'block' }}
      onMouseDown={(event) => {
        setMouseIsDown(true);
        setMovedDuringLastMouseDown(false);
        setInitialMousePos({ x: event.clientX, y: event.clientY });
        onMouseDown?.(event);
      }}
      onMouseUp={(event) => {
        setMouseIsDown(false);
        setInitialMousePos(undefined);
        onMouseUp?.(event);
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseOver={onMouseOver}
      onMouseOut={onMouseOut}
      onMouseMove={(event) => {
        if (mouseIsDown && initialMousePos) {
          const dx = event.clientX - initialMousePos.x;
          const dy = event.clientY - initialMousePos.y;
          if (Math.abs(dx) > 8 || Math.abs(dy) > 8) setMovedDuringLastMouseDown(true);
        }
        onMouseMove?.(event, featureId(event));
      }}
      onClick={(event) => {
        if (movedDuringLastMouseDown) return;
        const id = featureId(event);
        if (id) {
          // Match JBrowse's native SVG overlay: a feature click selects the
          // feature and must not bubble into the blank-canvas handler, which
          // would immediately clear that selection.
          event.stopPropagation();
          onFeatureClick?.(event, id);
        } else {
          onClick?.(event);
        }
      }}
      onContextMenu={(event) => {
        const id = featureId(event);
        if (id) onFeatureContextMenu?.(event, id);
        else onContextMenu?.(event);
      }}
    >
      {children}
    </svg>
  );
});

export const PromoterFeatureRendering = observer(function PromoterFeatureRendering(props: StrandRendererProps) {
  const glyphs = [...props.features.values()].map((feature) => renderPromoterFeature(feature, props));
  return props.exportSVG
    ? <>{glyphs}</>
    : <FeatureSvgWrapper {...props} minimumHeight={PROMOTER_GLYPH_HEIGHT} testId={`seqedge-promoter-rendering-${props.blockKey}`}>{glyphs}</FeatureSvgWrapper>;
});

export const DirectionalAnnotationRendering = observer(function DirectionalAnnotationRendering(props: StrandRendererProps) {
  const features = visibleAnnotationFeatures(props.features);
  const region = props.regions[0];
  const jointLayout = new GranularRectLayout<{ featureId: string }>({
    pitchX: 1,
    pitchY: 1,
    maxHeight: 10000,
  });
  const placedFeatures = features.flatMap((feature) => {
    const interval = screenInterval(feature, region, props.bpPerPx);
    if (!interval.visible || !interval.width) return [];
    const id = String(feature.id());
    const label = featureName(feature);
    const labelWidth = measureText(label, 11);
    const labelPlacement = annotationLabelPlacement(feature, region, props.bpPerPx, labelWidth);
    const direction = screenDirection(feature.get('strand'), region.reversed);
    const arrowGeometry = separateArrowFromBody(
      interval,
      direction,
      annotationArrowPlacement(feature, direction, interval),
    );
    const arrowTail = arrowGeometry.placement
      ? arrowGeometry.placement.tip - direction * FEATURE_ARROW_LENGTH
      : undefined;
    const arrowLeft = arrowGeometry.placement
      ? Math.min(arrowGeometry.left, arrowGeometry.placement.tip, arrowTail!)
      : arrowGeometry.left;
    const arrowRight = arrowGeometry.placement
      ? Math.max(arrowGeometry.right, arrowGeometry.placement.tip, arrowTail!)
      : arrowGeometry.right;
    const collisionLeft = Math.min(arrowLeft, labelPlacement.visible ? labelPlacement.x : arrowLeft);
    const collisionRight = Math.max(arrowRight, labelPlacement.visible
      ? labelPlacement.x + labelPlacement.width
      : arrowRight);
    const layoutId = annotationLayoutId(id);
    const top = jointLayout.addRect(
      layoutId,
      collisionLeft,
      collisionRight + ANNOTATION_JOINT_GAP,
      ANNOTATION_JOINT_LANE_HEIGHT,
      { featureId: id },
    );
    return top === null ? [] : [{ feature, labelPlacement, layoutId, top }];
  });
  const glyphs = placedFeatures.map(({ feature, labelPlacement, layoutId, top }) => (
    renderAnnotationFeature(feature, props, top, labelPlacement, layoutId)
  ));
  const contentHeight = Math.max(ANNOTATION_JOINT_LANE_HEIGHT, jointLayout.getTotalHeight());
  return props.exportSVG
    ? <>{glyphs}</>
    : <FeatureSvgWrapper
        {...props}
        contentHeight={contentHeight}
        minimumHeight={ANNOTATION_JOINT_LANE_HEIGHT}
        testId={`seqedge-annotation-rendering-${props.blockKey}`}
      >{glyphs}</FeatureSvgWrapper>;
});
