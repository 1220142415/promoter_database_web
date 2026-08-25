'use client';

import { useEffect, useRef, useState } from 'react';
import { bpToPx, type Feature, type Region } from '@jbrowse/core/util';
import { observer } from 'mobx-react';
import {
  MINUS_STRAND_COLOR,
  PLUS_STRAND_COLOR,
  normalizeStrand,
  screenDirection,
  strandLabel,
  type NormalizedStrand,
} from '@/jbrowse/strand-feature-renderer';

export const EXPERIMENTAL_TSS_GLYPH_HEIGHT = 24;
export const EXPERIMENTAL_TSS_FLAG_LENGTH = 6;
export const EXPERIMENTAL_TSS_POLE_HEIGHT = 14;
const FLAG_TOP = 4;
const FLAG_HALF_HEIGHT = 3;
const SVG_HEIGHT_PADDING = 2;
const POLE_COLOR = '#1f2937';

type LayoutRect = [number, number, number, number];

type FeatureLayout = {
  addRect: (id: string, left: number, right: number, height: number, data?: unknown) => number | null;
  getDataByID?: (id: string) => unknown;
  getTotalHeight: () => number;
};

type DisplayModel = {
  featureUnderMouse?: Feature;
  featureIdUnderMouse?: string;
  selectedFeatureId?: string;
  getFeatureByID?: (blockKey: string, featureId: string) => LayoutRect;
  getFeatureOverlapping?: (blockKey: string, bp: number, y: number) => string | undefined;
};

export type ExperimentalTssRendererProps = {
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

export function experimentalTssAnchorPosition(feature: Feature) {
  const start = Number(feature.get('start'));
  return Number.isFinite(start) ? start + 0.5 : 0.5;
}

export function experimentalTssCoordinate(feature: Feature) {
  const start = Number(feature.get('start'));
  return Number.isFinite(start) ? start + 1 : 1;
}

export function experimentalTssColor(feature: Feature) {
  return normalizeStrand(feature.get('strand')) === -1 ? MINUS_STRAND_COLOR : PLUS_STRAND_COLOR;
}

export function experimentalTssLayoutBounds(anchor: number, bpPerPx: number) {
  const padding = EXPERIMENTAL_TSS_FLAG_LENGTH * bpPerPx;
  return { start: anchor - padding, end: anchor + padding };
}

function featureAtEvent(
  event: React.MouseEvent,
  element: SVGSVGElement | null,
  props: ExperimentalTssRendererProps,
  width: number,
) {
  const directFeatureId = event.target instanceof Element
    ? event.target.closest('[data-direct-feature-id]')?.getAttribute('data-direct-feature-id')
    : undefined;
  if (directFeatureId) return directFeatureId;
  if (!element || !props.displayModel?.getFeatureOverlapping) return undefined;
  const region = props.regions[0];
  const rect = element.getBoundingClientRect();
  const visibleX = Math.max(0, Math.min(width, event.clientX - rect.left));
  const genomicX = region.reversed ? width - visibleX : visibleX;
  const layoutId = props.displayModel.getFeatureOverlapping(
    props.blockKey,
    region.start + props.bpPerPx * genomicX,
    event.clientY - rect.top,
  );
  if (!layoutId) return undefined;
  const data = props.layout.getDataByID?.(layoutId) as { featureId?: unknown } | undefined;
  return typeof data?.featureId === 'string' ? data.featureId : layoutId;
}

function flagPoints(anchorX: number, top: number, direction: NormalizedStrand) {
  const tipX = anchorX + direction * EXPERIMENTAL_TSS_FLAG_LENGTH;
  return `${anchorX},${top} ${tipX},${top + FLAG_HALF_HEIGHT} ${anchorX},${top + FLAG_HALF_HEIGHT * 2}`;
}

function renderExperimentalTssFeature(feature: Feature, props: ExperimentalTssRendererProps) {
  const region = props.regions[0];
  const id = String(feature.id());
  const anchor = experimentalTssAnchorPosition(feature);
  const anchorX = bpToPx(anchor, region, props.bpPerPx);
  const viewportWidth = (region.end - region.start) / props.bpPerPx;
  if (anchorX < -EXPERIMENTAL_TSS_FLAG_LENGTH || anchorX > viewportWidth + EXPERIMENTAL_TSS_FLAG_LENGTH) return null;

  const bounds = experimentalTssLayoutBounds(anchor, props.bpPerPx);
  const top = props.layout.addRect(id, bounds.start, bounds.end, EXPERIMENTAL_TSS_GLYPH_HEIGHT, {
    featureId: id,
    label: feature.get('name') || feature.get('id'),
    refName: feature.get('refName'),
  });
  if (top === null) return null;

  const strand = normalizeStrand(feature.get('strand'));
  const direction = screenDirection(strand, region.reversed);
  const color = experimentalTssColor(feature);
  const poleTop = top + FLAG_TOP;
  const poleBottom = poleTop + EXPERIMENTAL_TSS_POLE_HEIGHT;
  const tipX = anchorX + direction * EXPERIMENTAL_TSS_FLAG_LENGTH;
  const visualLeft = Math.min(anchorX - 1, tipX);
  const visualRight = Math.max(anchorX + 1, tipX);
  const hovered = props.displayModel?.featureIdUnderMouse === id
    || props.displayModel?.featureUnderMouse?.id?.() === id;
  const selected = props.displayModel?.selectedFeatureId === id;

  return (
    <g
      key={id}
      data-direct-feature-id={id}
      data-feature-id={id}
      data-feature-type="experimental-tss"
      data-evidence-type="experimental"
      data-strand={strandLabel(strand)}
      data-screen-direction={direction}
      data-anchor-coordinate={experimentalTssCoordinate(feature)}
    >
      <title>Experimental TSS at {String(feature.get('refName') || '')}:{experimentalTssCoordinate(feature)}</title>
      <line
        data-role="experimental-tss-pole"
        data-anchor="exact-tss"
        x1={anchorX}
        x2={anchorX}
        y1={poleTop}
        y2={poleBottom}
        stroke={POLE_COLOR}
        strokeWidth="1.5"
      />
      {direction ? <polygon
        data-role="experimental-tss-flag"
        data-anchor="exact-tss"
        points={flagPoints(anchorX, poleTop, direction)}
        fill={color}
      /> : null}
      {hovered ? <rect
        data-role="experimental-tss-hover"
        x={visualLeft}
        y={poleTop - 1}
        width={Math.max(2, visualRight - visualLeft)}
        height={EXPERIMENTAL_TSS_POLE_HEIGHT + 2}
        fill="#000"
        fillOpacity="0.12"
      /> : null}
      {selected ? <rect
        data-role="experimental-tss-selected"
        x={visualLeft - 1}
        y={poleTop - 2}
        width={Math.max(4, visualRight - visualLeft + 2)}
        height={EXPERIMENTAL_TSS_POLE_HEIGHT + 4}
        fill="none"
        stroke="#00b8ff"
        strokeWidth="2"
      /> : null}
    </g>
  );
}

const ExperimentalTssSvg = observer(function ExperimentalTssSvg(props: ExperimentalTssRendererProps) {
  const region = props.regions[0];
  const width = (region.end - region.start) / props.bpPerPx;
  const ref = useRef<SVGSVGElement>(null);
  const [mouseIsDown, setMouseIsDown] = useState(false);
  const [moved, setMoved] = useState(false);
  const [initialMousePos, setInitialMousePos] = useState<{ x: number; y: number }>();
  const glyphs = [...props.features.values()].map((feature) => renderExperimentalTssFeature(feature, props));
  const resolvedHeight = Math.max(EXPERIMENTAL_TSS_GLYPH_HEIGHT, props.layout.getTotalHeight());
  const [height, setHeight] = useState(resolvedHeight);
  useEffect(() => setHeight(resolvedHeight), [resolvedHeight]);
  const featureId = (event: React.MouseEvent) => featureAtEvent(event, ref.current, props, width);

  return (
    <svg
      ref={ref}
      data-testid={`seqedge-experimental-tss-rendering-${props.blockKey}`}
      width={width}
      height={height + SVG_HEIGHT_PADDING}
      style={{ display: 'block' }}
      onMouseDown={(event) => {
        setMouseIsDown(true);
        setMoved(false);
        setInitialMousePos({ x: event.clientX, y: event.clientY });
        props.onMouseDown?.(event);
      }}
      onMouseUp={(event) => {
        setMouseIsDown(false);
        setInitialMousePos(undefined);
        props.onMouseUp?.(event);
      }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseMove={(event) => {
        if (mouseIsDown && initialMousePos) {
          const dx = event.clientX - initialMousePos.x;
          const dy = event.clientY - initialMousePos.y;
          if (Math.abs(dx) > 8 || Math.abs(dy) > 8) setMoved(true);
        }
        props.onMouseMove?.(event, featureId(event));
      }}
      onClick={(event) => {
        if (moved) return;
        const id = featureId(event);
        if (id) {
          event.stopPropagation();
          props.onFeatureClick?.(event, id);
        } else props.onClick?.(event);
      }}
      onContextMenu={(event) => {
        const id = featureId(event);
        if (id) props.onFeatureContextMenu?.(event, id);
        else props.onContextMenu?.(event);
      }}
    >
      {glyphs}
    </svg>
  );
});

export const ExperimentalTssRendering = observer(function ExperimentalTssRendering(props: ExperimentalTssRendererProps) {
  return props.exportSVG
    ? <>{[...props.features.values()].map((feature) => renderExperimentalTssFeature(feature, props))}</>
    : <ExperimentalTssSvg {...props} />;
});
