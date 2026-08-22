// @vitest-environment jsdom

import type { ComponentProps } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Feature, Region } from '@jbrowse/core/util';
import {
  DirectionalAnnotationRendering,
  DirectionalGlyph,
  MINUS_STRAND_COLOR,
  PLUS_STRAND_COLOR,
  PROMOTER_BODY_MIN_WIDTH,
  PROMOTER_FLAG_LENGTH,
  PROMOTER_FLAG_POLE_HEIGHT,
  PromoterFeatureRendering,
  SVG_HEIGHT_PADDING,
  UNKNOWN_STRAND_COLOR,
  annotationLayoutId,
  annotationLabelPlacement,
  isFormalPromoter,
  isRegionFeature,
  normalizeStrand,
  promoterAnchorCoordinate,
  promoterFlagLayoutBounds,
  screenDirection,
  shouldShowPromoterBody,
  strandColor,
  strandLabel,
  visibleAnnotationFeatures,
} from '@/jbrowse/strand-feature-renderer';

function feature(
  id: string,
  type: string,
  strand: number | string,
  start: number,
  end: number,
  extra: Record<string, unknown> = {},
) {
  const data: Record<string, unknown> = {
    id,
    name: id,
    refName: 'contig_1',
    start,
    end,
    strand,
    type,
    ...extra,
  };
  return {
    id: () => id,
    get: (key: string) => data[key],
  } as unknown as Feature;
}

const forwardRegion = {
  assemblyName: 'GCA_test',
  refName: 'contig_1',
  start: 0,
  end: 300,
  reversed: false,
} as Region;

function renderingProps(features: Map<string, Feature>, layout = { addRect: vi.fn().mockReturnValue(0), getTotalHeight: () => 24 }) {
  return {
    blockKey: 'block-1',
    bpPerPx: 1,
    config: {},
    features,
    layout,
    regions: [forwardRegion],
  } as ComponentProps<typeof PromoterFeatureRendering>;
}

describe('strand feature geometry', () => {
  it('keeps biological colors stable while reversing screen direction', () => {
    expect(normalizeStrand('+')).toBe(1);
    expect(normalizeStrand(-1)).toBe(-1);
    expect(normalizeStrand('.')).toBe(0);
    expect(strandColor(1)).toBe('#0f766e');
    expect(strandColor(-1)).toBe('#be123c');
    expect(strandColor(0)).toBe(UNKNOWN_STRAND_COLOR);
    expect(strandLabel(0)).toBe('unknown');
    expect(screenDirection(1, false)).toBe(1);
    expect(screenDirection(1, true)).toBe(-1);
    expect(screenDirection(-1, true)).toBe(1);
  });

  it('places the anchor on the 80th promoter base in transcription orientation', () => {
    const plus = feature('plus', 'promoter', 1, 0, 100);
    const minus = feature('minus', 'promoter', -1, 100, 200);
    expect(isFormalPromoter(plus)).toBe(true);
    expect(isFormalPromoter(minus)).toBe(true);
    expect(promoterAnchorCoordinate(plus)).toBe(80);
    expect(promoterAnchorCoordinate(minus)).toBe(121);
  });

  it('switches from flag-only to flag-plus-body at twelve pixels', () => {
    expect(shouldShowPromoterBody(PROMOTER_BODY_MIN_WIDTH - 0.1)).toBe(false);
    expect(shouldShowPromoterBody(PROMOTER_BODY_MIN_WIDTH)).toBe(true);
  });

  it('expands promoter collision bounds to cover the fixed-pixel flag', () => {
    expect(promoterFlagLayoutBounds(0, 100, 79.5, 1, 20)).toEqual({ start: 0, end: 199.5 });
    expect(promoterFlagLayoutBounds(100, 200, 120.5, -1, 20)).toEqual({ start: 0.5, end: 200 });
  });

  it('filters NCBI region roots before they enter collision layout', () => {
    const regionFeature = feature('contig', 'region', 1, 0, 300);
    const riboswitch = feature('riboswitch', 'binding_site', -1, 20, 80);
    expect(isRegionFeature(regionFeature)).toBe(true);
    expect(visibleAnnotationFeatures(new Map([
      [regionFeature.id(), regionFeature],
      [riboswitch.id(), riboswitch],
    ]))).toEqual([riboswitch]);
  });
});

describe('strand feature SVG output', () => {
  it('renders a wide 100 bp promoter body and an anchored fixed-pixel flag', () => {
    const plus = feature('promoter-plus', 'promoter', 1, 0, 100);
    const minus = feature('promoter-minus', 'promoter', -1, 100, 200);
    const layout = { addRect: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(24), getTotalHeight: () => 48 };
    const { container } = render(<PromoterFeatureRendering {...renderingProps(
      new Map([[plus.id(), plus], [minus.id(), minus]]),
      layout,
    )} />);

    const plusGlyph = container.querySelector('[data-feature-id="promoter-plus"]');
    const minusGlyph = container.querySelector('[data-feature-id="promoter-minus"]');
    expect(plusGlyph).toHaveAttribute('data-formal-promoter', 'true');
    expect(minusGlyph).toHaveAttribute('data-formal-promoter', 'true');
    expect(plusGlyph?.querySelector('[data-role="promoter-body"]')).toHaveAttribute('fill', PLUS_STRAND_COLOR);
    expect(minusGlyph?.querySelector('[data-role="promoter-body"]')).toHaveAttribute('fill', MINUS_STRAND_COLOR);
    expect(plusGlyph?.querySelector('[data-role="promoter-body"]')).toHaveAttribute('width', '100');
    expect(minusGlyph?.querySelector('[data-role="promoter-body"]')).toHaveAttribute('width', '100');
    expect(plusGlyph?.querySelector('[data-role="promoter-body"]')).toHaveAttribute('fill-opacity', '1');
    expect(plusGlyph?.querySelector('[data-role="promoter-flag-pole"]')).toHaveAttribute('x1', '79.5');
    expect(minusGlyph?.querySelector('[data-role="promoter-flag-pole"]')).toHaveAttribute('x1', '120.5');
    expect(Number(plusGlyph?.querySelector('[data-role="promoter-flag-pole"]')?.getAttribute('y2'))
      - Number(plusGlyph?.querySelector('[data-role="promoter-flag-pole"]')?.getAttribute('y1'))).toBe(PROMOTER_FLAG_POLE_HEIGHT);
    expect(plusGlyph?.querySelector('[data-role="promoter-flag"]')).toHaveAttribute('fill', PLUS_STRAND_COLOR);
    expect(minusGlyph?.querySelector('[data-role="promoter-flag"]')).toHaveAttribute('fill', MINUS_STRAND_COLOR);
    expect(plusGlyph?.querySelector('[data-role="promoter-arrow"]')).toBeNull();
    expect(minusGlyph?.querySelector('[data-role="promoter-arrow"]')).toBeNull();
    expect(container.textContent).not.toContain('TSS');
    expect(container.querySelector('[data-role="promoter-tss-label"]')).toBeNull();
    expect(container.querySelector('[data-role="promoter-bracket"]')).toBeNull();
    expect(layout.addRect).toHaveBeenNthCalledWith(1, 'promoter-plus', 0, 100, 24, expect.any(Object));
    expect(layout.addRect).toHaveBeenNthCalledWith(2, 'promoter-minus', 100, 200, 24, expect.any(Object));
    expect(container.querySelector('svg')).toHaveAttribute('height', String(48 + SVG_HEIGHT_PADDING));
  });

  it('renders only fixed-pixel flags below the twelve-pixel interval threshold', () => {
    const plus = feature('promoter-plus', 'promoter', 1, 0, 100);
    const minus = feature('promoter-minus', 'promoter', -1, 100, 200);
    const layout = { addRect: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(24), getTotalHeight: () => 48 };
    const props = {
      ...renderingProps(new Map([[plus.id(), plus], [minus.id(), minus]]), layout),
      bpPerPx: 20,
    } as ComponentProps<typeof PromoterFeatureRendering>;
    const { container } = render(<PromoterFeatureRendering {...props} />);
    const plusGlyph = container.querySelector('[data-feature-id="promoter-plus"]');
    const minusGlyph = container.querySelector('[data-feature-id="promoter-minus"]');
    expect(plusGlyph?.querySelector('[data-role="promoter-body"]')).toBeNull();
    expect(minusGlyph?.querySelector('[data-role="promoter-body"]')).toBeNull();
    expect(plusGlyph?.querySelector('[data-role="promoter-flag"]')).toBeInTheDocument();
    expect(minusGlyph?.querySelector('[data-role="promoter-flag"]')).toBeInTheDocument();
    expect(layout.addRect).toHaveBeenNthCalledWith(1, 'promoter-plus', 0, 199.5, 24, expect.any(Object));
    expect(layout.addRect).toHaveBeenNthCalledWith(2, 'promoter-minus', 0.5, 200, 24, expect.any(Object));
  });

  it('flips promoter arrows in a reversed view without changing their colors', () => {
    const plus = feature('promoter-plus', 'promoter', 1, 0, 100);
    const layout = { addRect: vi.fn().mockReturnValue(0), getTotalHeight: () => 24 };
    const props = {
      ...renderingProps(new Map([[plus.id(), plus]]), layout),
      regions: [{ ...forwardRegion, reversed: true }],
    } as ComponentProps<typeof PromoterFeatureRendering>;
    const { container } = render(<PromoterFeatureRendering {...props} />);
    const glyph = container.querySelector('[data-feature-id="promoter-plus"]');
    expect(glyph).toHaveAttribute('data-strand', '+');
    expect(glyph).toHaveAttribute('data-screen-direction', '-1');
    expect(glyph?.querySelector('[data-role="promoter-body"]')).toHaveAttribute('fill', PLUS_STRAND_COLOR);
    expect(glyph?.querySelector('[data-role="promoter-flag"]')).toHaveAttribute('fill', PLUS_STRAND_COLOR);
    expect(glyph?.querySelector('[data-role="promoter-flag"]')?.getAttribute('points')).toContain(String(220.5 - PROMOTER_FLAG_LENGTH));
  });

  it('renders legacy promoter peaks as point-compatible bodies without an overlapping arrow or false anchor', () => {
    const peak = feature('peak', 'promoter_peak', -1, 50, 51);
    const { container } = render(<PromoterFeatureRendering {...renderingProps(new Map([[peak.id(), peak]]))} />);
    const glyph = container.querySelector('[data-feature-id="peak"]');
    expect(glyph).toHaveAttribute('data-formal-promoter', 'false');
    expect(glyph?.querySelector('[data-role="promoter-body"]')).toHaveAttribute('width', '3');
    expect(glyph?.querySelector('[data-role="promoter-flag-pole"]')).toBeNull();
    expect(glyph?.querySelector('[data-role="promoter-arrow"]')).toBeNull();
  });

  it('does not fake a formal promoter flag at a clipped anchor', () => {
    const promoter = feature('clipped-promoter', 'promoter', 1, 0, 100);
    const layout = { addRect: vi.fn().mockReturnValue(0), getTotalHeight: () => 24 };
    const props = {
      ...renderingProps(new Map([[promoter.id(), promoter]]), layout),
      regions: [{ ...forwardRegion, start: 90, end: 190 }],
    } as ComponentProps<typeof PromoterFeatureRendering>;
    const { container } = render(<PromoterFeatureRendering {...props} />);
    expect(container.querySelector('[data-feature-id="clipped-promoter"]')).toBeNull();
    expect(layout.addRect).not.toHaveBeenCalled();
  });

  it('keeps a visible wide promoter body without fabricating a clipped flag', () => {
    const promoter = feature('clipped-promoter', 'promoter', 1, 0, 100);
    const props = {
      ...renderingProps(new Map([[promoter.id(), promoter]])),
      bpPerPx: 0.5,
      regions: [{ ...forwardRegion, start: 90, end: 190 }],
    } as ComponentProps<typeof PromoterFeatureRendering>;
    const { container } = render(<PromoterFeatureRendering {...props} />);
    const glyph = container.querySelector('[data-feature-id="clipped-promoter"]');
    expect(glyph?.querySelector('[data-role="promoter-body"]')).toHaveAttribute('width', '20');
    expect(glyph?.querySelector('[data-role="promoter-flag-pole"]')).toBeNull();
  });

  it('draws attached arrows for every stranded annotation part, including children', () => {
    const child = feature('cds-child', 'CDS', -1, 22, 48);
    const gene = feature('gene-parent', 'gene', 1, 10, 60, { subfeatures: [child] });
    const { container } = render(
      <svg>
        <DirectionalGlyph feature={gene} region={forwardRegion} bpPerPx={1} top={0} />
        <DirectionalGlyph feature={child} region={forwardRegion} bpPerPx={1} top={12} />
      </svg>,
    );
    expect(container.querySelector('[data-feature-id="gene-parent"] [data-role="feature-body"]')).toHaveAttribute('fill', PLUS_STRAND_COLOR);
    expect(container.querySelector('[data-feature-id="gene-parent"] [data-role="feature-arrow"]'))
      .toHaveAttribute('x1', '60');
    expect(container.querySelector('[data-feature-id="gene-parent"] [data-role="feature-arrow"]'))
      .toHaveAttribute('x2', '66');
    expect(container.querySelector('[data-feature-id="gene-parent"] [data-role="feature-arrow-head"]'))
      .toHaveAttribute('points', '66,5 63,2.5 63,7.5');
    expect(container.querySelector('[data-feature-id="cds-child"] [data-role="feature-body"]')).toHaveAttribute('fill', MINUS_STRAND_COLOR);
    expect(container.querySelector('[data-feature-id="cds-child"] [data-role="feature-arrow"]'))
      .toHaveAttribute('x1', '22');
    expect(container.querySelector('[data-feature-id="cds-child"] [data-role="feature-arrow"]'))
      .toHaveAttribute('x2', '16');
    expect(container.querySelector('[data-feature-id="cds-child"] [data-role="feature-arrow-head"]'))
      .toHaveAttribute('points', '16,17 19,14.5 19,19.5');
  });

  it('keeps the minimum body and omits arrows that cannot be separated or lack a real endpoint', () => {
    const narrow = feature('narrow', 'tRNA', 1, 10, 11);
    const { container } = render(
      <svg>
        <DirectionalGlyph feature={narrow} region={forwardRegion} bpPerPx={10} top={0} />
      </svg>,
    );
    const narrowGlyph = container.querySelector('[data-feature-id="narrow"]');
    expect(narrowGlyph?.querySelector('[data-role="feature-body"]')).toHaveAttribute('width', '3');
    expect(narrowGlyph?.querySelector('[data-role="feature-arrow"]')).toBeNull();

    const clippedPlus = feature('clipped-plus', 'gene', 1, 10, 100);
    const clippedMinus = feature('clipped-minus', 'gene', -1, 40, 100);
    const { container: clippedContainer } = render(
      <svg>
        <DirectionalGlyph feature={clippedPlus} region={{ ...forwardRegion, end: 50 }} bpPerPx={1} top={0} />
        <DirectionalGlyph feature={clippedMinus} region={{ ...forwardRegion, start: 50, end: 150 }} bpPerPx={1} top={12} />
      </svg>,
    );
    expect(clippedContainer.querySelector('[data-feature-id="clipped-plus"] [data-role="feature-arrow"]')).toBeNull();
    expect(clippedContainer.querySelector('[data-feature-id="clipped-minus"] [data-role="feature-arrow"]')).toBeNull();
    expect(clippedContainer.querySelector('[data-clipped-marker]')).toBeNull();
  });

  it('reserves body space for true endpoint arrows at both SVG boundaries', () => {
    const plus = feature('plus-boundary', 'gene', 1, 200, 300);
    const minus = feature('minus-boundary', 'gene', -1, 0, 100);
    const { container } = render(
      <svg>
        <DirectionalGlyph feature={plus} region={forwardRegion} bpPerPx={1} top={0} />
        <DirectionalGlyph feature={minus} region={forwardRegion} bpPerPx={1} top={12} />
      </svg>,
    );
    const plusBody = container.querySelector('[data-feature-id="plus-boundary"] [data-role="feature-body"]');
    const minusBody = container.querySelector('[data-feature-id="minus-boundary"] [data-role="feature-body"]');
    const plusArrow = container.querySelector('[data-feature-id="plus-boundary"] [data-role="feature-arrow"]');
    const minusArrow = container.querySelector('[data-feature-id="minus-boundary"] [data-role="feature-arrow"]');
    expect(plusBody).toHaveAttribute('x', '200');
    expect(plusBody).toHaveAttribute('width', '94');
    expect(plusArrow).toHaveAttribute('x1', '294');
    expect(plusArrow).toHaveAttribute('x2', '300');
    expect(minusBody).toHaveAttribute('x', '6');
    expect(minusBody).toHaveAttribute('width', '94');
    expect(minusArrow).toHaveAttribute('x1', '6');
    expect(minusArrow).toHaveAttribute('x2', '0');
    expect(container.querySelector('[data-feature-id="plus-boundary"] [data-role="feature-arrow-head"]'))
      .toHaveAttribute('points', '300,5 297,2.5 297,7.5');
    expect(container.querySelector('[data-feature-id="minus-boundary"] [data-role="feature-arrow-head"]'))
      .toHaveAttribute('points', '0,17 3,14.5 3,19.5');
  });

  it('keeps a reversed-view endpoint arrow outside the unchanged strand-colored body', () => {
    const plus = feature('plus-reversed', 'gene', 1, 10, 60);
    const { container } = render(
      <svg>
        <DirectionalGlyph feature={plus} region={{ ...forwardRegion, reversed: true }} bpPerPx={1} top={0} />
      </svg>,
    );
    const glyph = container.querySelector('[data-feature-id="plus-reversed"]');
    const body = glyph?.querySelector('[data-role="feature-body"]');
    const arrow = glyph?.querySelector('[data-role="feature-arrow"]');
    expect(glyph).toHaveAttribute('data-screen-direction', '-1');
    expect(body).toHaveAttribute('fill', PLUS_STRAND_COLOR);
    expect(body).toHaveAttribute('x', '240');
    expect(arrow).toHaveAttribute('x1', '240');
    expect(arrow).toHaveAttribute('x2', '234');
  });

  it('deduplicates nearby parent and child arrows but keeps distinct endpoints', () => {
    const coincidentChild = feature('coincident-cds', 'CDS', 1, 20, 100);
    const distinctChild = feature('distinct-exon', 'exon', 1, 30, 90);
    const gene = feature('parent-gene', 'gene', 1, 10, 100, {
      subfeatures: [coincidentChild, distinctChild],
    });
    const props = {
      ...renderingProps(new Map([[gene.id(), gene]])),
    } as ComponentProps<typeof DirectionalAnnotationRendering>;
    const { container } = render(<DirectionalAnnotationRendering {...props} />);

    expect(container.querySelectorAll('[data-role="feature-body"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-role="feature-arrow"]')).toHaveLength(2);
    expect(container.querySelector('[data-feature-id="parent-gene"] [data-role="feature-arrow"]')).toBeInTheDocument();
    expect(container.querySelector('[data-feature-id="coincident-cds"] [data-role="feature-arrow"]')).toBeNull();
    expect(container.querySelector('[data-feature-id="distinct-exon"] [data-role="feature-arrow"]')).toBeInTheDocument();
    const root = container.querySelector('[data-annotation-root="parent-gene"]')!;
    const orderedRoles = [...root.querySelectorAll('[data-role]')].map((element) => element.getAttribute('data-role'));
    const lastBody = orderedRoles.lastIndexOf('feature-body');
    const firstArrow = orderedRoles.indexOf('feature-arrow');
    expect(firstArrow).toBeGreaterThan(lastBody);
    expect(root.querySelector('[data-role="feature-arrow"]')?.closest('[data-arrow-overlay]'))
      .toHaveAttribute('data-arrow-overlay', 'true');
  });

  it('uses neutral gray and no arrow for unknown strand', () => {
    const unknown = feature('unknown', 'exon', '.', 10, 30);
    const { container } = render(
      <svg>
        <DirectionalGlyph feature={unknown} region={forwardRegion} bpPerPx={1} top={0} />
      </svg>,
    );
    const glyph = container.querySelector('[data-feature-id="unknown"]');
    expect(glyph).toHaveAttribute('data-strand', 'unknown');
    expect(glyph?.querySelector('[data-role="feature-body"]')).toHaveAttribute('fill', UNKNOWN_STRAND_COLOR);
    expect(glyph?.querySelector('[data-role="feature-arrow"]')).toBeNull();
  });

  it('keeps feature clicks and context menus from reaching blank-canvas handlers', () => {
    const promoter = feature('promoter-click', 'promoter', 1, 0, 100);
    const onFeatureClick = vi.fn();
    const onClick = vi.fn();
    const onFeatureContextMenu = vi.fn();
    const onContextMenu = vi.fn();
    const props = {
      ...renderingProps(new Map([[promoter.id(), promoter]])),
      displayModel: { getFeatureOverlapping: () => promoter.id() },
      onFeatureClick,
      onClick,
      onFeatureContextMenu,
      onContextMenu,
    } as ComponentProps<typeof PromoterFeatureRendering>;
    const { container } = render(<PromoterFeatureRendering {...props} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    fireEvent.click(svg!);
    fireEvent.contextMenu(svg!);
    expect(onFeatureClick).toHaveBeenCalledWith(expect.anything(), promoter.id());
    expect(onFeatureContextMenu).toHaveBeenCalledWith(expect.anything(), promoter.id());
    expect(onClick).not.toHaveBeenCalled();
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('filters region features from the complete annotation rendering', () => {
    const regionFeature = feature('contig', 'region', 1, 0, 300);
    const riboswitch = feature('riboswitch', 'binding_site', -1, 20, 80);
    const addRect = vi.fn().mockReturnValue(0);
    const props = {
      ...renderingProps(new Map([
        [regionFeature.id(), regionFeature],
        [riboswitch.id(), riboswitch],
      ]), { addRect, getTotalHeight: () => 24 }),
    } as ComponentProps<typeof DirectionalAnnotationRendering>;
    const { container } = render(<DirectionalAnnotationRendering {...props} />);
    expect(container.querySelector('[data-feature-id="contig"]')).toBeNull();
    expect(container.querySelector('[data-feature-id="riboswitch"] [data-role="feature-body"]')).toHaveAttribute('fill', MINUS_STRAND_COLOR);
    expect(addRect).not.toHaveBeenCalled();
    expect(container.querySelector(`[data-annotation-root="${riboswitch.id()}"]`)).toHaveAttribute(
      'data-layout-id',
      annotationLayoutId(riboswitch.id()),
    );
    expect(container.querySelector('svg')).toHaveAttribute('height', String(24 + SVG_HEIGHT_PADDING));
  });

  it('centers the full annotation label and includes its measured box in collision bounds', () => {
    const gene = feature('gene', 'gene', 1, 100, 110);
    expect(annotationLabelPlacement(gene, forwardRegion, 1, 80)).toEqual({
      visible: true,
      midpoint: 105,
      x: 65,
      width: 80,
      layoutStart: 65,
      layoutEnd: 145,
    });
  });

  it('uses a versioned annotation layout ID that stays stable across view changes', () => {
    expect(annotationLayoutId('gene')).toBe('seqedge-annotation-joint-v2:gene');
    expect(annotationLayoutId('other-gene')).not.toBe(annotationLayoutId('gene'));
  });

  it('draws a cross-block annotation label only in the block containing its midpoint', () => {
    const gene = feature('gene-midpoint', 'gene', 1, 20, 100);
    const firstProps = {
      ...renderingProps(new Map([[gene.id(), gene]])),
      regions: [{ ...forwardRegion, end: 60 }],
    } as ComponentProps<typeof DirectionalAnnotationRendering>;
    const secondProps = {
      ...renderingProps(new Map([[gene.id(), gene]])),
      regions: [{ ...forwardRegion, start: 60, end: 120 }],
    } as ComponentProps<typeof DirectionalAnnotationRendering>;
    const first = render(<DirectionalAnnotationRendering {...firstProps} />);
    const second = render(<DirectionalAnnotationRendering {...secondProps} />);
    expect(first.container.querySelector('[data-role="annotation-label"]')).toBeNull();
    expect(second.container.querySelector('[data-role="annotation-label"]')).toHaveTextContent('gene-midpoint');
  });

  it('moves each feature body and its parent label together into collision-assigned lanes', () => {
    const child = feature('child-cds', 'CDS', 1, 22, 48);
    const first = feature('gene-first', 'gene', 1, 10, 60, { subfeatures: [child] });
    const second = feature('gene-second', 'gene', -1, 20, 70);
    const layout = { addRect: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(24), getTotalHeight: () => 48 };
    const props = renderingProps(new Map([[first.id(), first], [second.id(), second]]), layout) as ComponentProps<typeof DirectionalAnnotationRendering>;
    const { container } = render(<DirectionalAnnotationRendering {...props} />);
    const labels = [...container.querySelectorAll('[data-role="annotation-label"]')];
    expect(labels).toHaveLength(2);
    expect(labels.map((label) => label.getAttribute('y'))).toEqual(['22', '46']);
    expect(labels.map((label) => label.textContent)).toEqual(['gene-first', 'gene-second']);
    expect(container.querySelector('[data-feature-id="gene-first"] [data-role="feature-body"]')).toHaveAttribute('y', '0');
    expect(container.querySelector('[data-feature-id="gene-second"] [data-role="feature-body"]')).toHaveAttribute('y', '24');
    expect(container.textContent).not.toContain('child-cds');
    expect(layout.addRect).not.toHaveBeenCalled();
    expect(container.querySelector('svg')).toHaveAttribute('height', String(48 + SVG_HEIGHT_PADDING));
  });

  it('keeps labels directly clickable without treating child glyphs as top-level layout hits', () => {
    const child = feature('child-cds', 'CDS', 1, 22, 48);
    const gene = feature('gene-parent', 'gene', 1, 10, 60, { subfeatures: [child] });
    const onFeatureClick = vi.fn();
    const props = {
      ...renderingProps(new Map([[gene.id(), gene]])),
      displayModel: { getFeatureOverlapping: () => undefined },
      onFeatureClick,
    } as ComponentProps<typeof DirectionalAnnotationRendering>;
    const { container } = render(<DirectionalAnnotationRendering {...props} />);
    fireEvent.click(container.querySelector('[data-role="annotation-label"]')!);
    expect(onFeatureClick).toHaveBeenCalledWith(expect.anything(), gene.id());
  });

  it('restores internal collision IDs to biological feature IDs for body clicks and context menus', () => {
    const gene = feature('gene-biological', 'gene', -1, 10, 60);
    const internalId = annotationLayoutId(gene.id());
    const onFeatureClick = vi.fn();
    const onFeatureContextMenu = vi.fn();
    const layout = {
      addRect: vi.fn().mockReturnValue(0),
      getDataByID: vi.fn().mockReturnValue({ featureId: gene.id() }),
      getTotalHeight: () => 24,
    };
    const props = {
      ...renderingProps(new Map([[gene.id(), gene]]), layout),
      displayModel: { getFeatureOverlapping: () => internalId },
      onFeatureClick,
      onFeatureContextMenu,
    } as ComponentProps<typeof DirectionalAnnotationRendering>;
    const { container } = render(<DirectionalAnnotationRendering {...props} />);
    const svg = container.querySelector('svg')!;
    fireEvent.click(svg);
    fireEvent.contextMenu(svg);
    expect(layout.getDataByID).toHaveBeenCalledWith(internalId);
    expect(onFeatureClick).toHaveBeenCalledWith(expect.anything(), gene.id());
    expect(onFeatureContextMenu).toHaveBeenCalledWith(expect.anything(), gene.id());
  });
});
