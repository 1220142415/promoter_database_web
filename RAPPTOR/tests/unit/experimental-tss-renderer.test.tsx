// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react';
import type { Feature, Region } from '@jbrowse/core/util';
import { describe, expect, it, vi } from 'vitest';
import {
  EXPERIMENTAL_TSS_FLAG_LENGTH,
  ExperimentalTssRendering,
  experimentalTssAnchorPosition,
  experimentalTssCoordinate,
} from '@/features/genome-browser/plugins/experimental-tss-renderer';
import { MINUS_STRAND_COLOR, PLUS_STRAND_COLOR } from '@/features/genome-browser/plugins/strand-feature-renderer';

function feature(id: string, start: number, strand: 1 | -1, extras: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    id,
    name: id,
    type: 'experimental_TSS',
    refName: 'NC_016810.1',
    start,
    end: start + 1,
    strand,
    evidence_type: 'experimental',
    ...extras,
  };
  return {
    id: () => id,
    get: (key: string) => data[key],
    toJSON: () => data,
  } as unknown as Feature;
}

function region(reversed = false): Region {
  return {
    assemblyName: 'GCF_000210855.2',
    refName: 'NC_016810.1',
    start: 0,
    end: 100,
    reversed,
  };
}

function layout(tops: number[] = [0]) {
  let totalHeight = 0;
  const addRect = vi.fn((id: string, left: number, right: number, height: number, data?: unknown) => {
    void [id, left, right, height, data];
    const top = tops.shift() ?? 0;
    totalHeight = Math.max(totalHeight, top + 24);
    return top;
  });
  return { addRect, getTotalHeight: () => totalHeight };
}

function props(features: Feature[], reversed = false, featureLayout = layout()) {
  return {
    blockKey: 'block-1',
    bpPerPx: 1,
    config: {},
    features: new Map(features.map((item) => [item.id(), item])),
    layout: featureLayout,
    regions: [region(reversed)],
  };
}

describe('experimental TSS renderer', () => {
  it('anchors a one-base observation at the exact base center without predicted-promoter expansion', () => {
    const item = feature('study-1:8', 9, 1);
    expect(experimentalTssCoordinate(item)).toBe(10);
    expect(experimentalTssAnchorPosition(item)).toBe(9.5);
    const { container } = render(<ExperimentalTssRendering {...props([item])} />);
    const pole = container.querySelector('[data-role="experimental-tss-pole"]');
    const flag = container.querySelector('[data-role="experimental-tss-flag"]');
    expect(pole).toHaveAttribute('x1', '9.5');
    expect(pole).toHaveAttribute('data-anchor', 'exact-tss');
    expect(flag).toHaveAttribute('fill', PLUS_STRAND_COLOR);
    expect(flag?.getAttribute('points')).toContain(String(9.5 + EXPERIMENTAL_TSS_FLAG_LENGTH));
    expect(container.querySelector('[data-role="promoter-body"]')).toBeNull();
  });

  it('keeps biological color while reversed view flips the screen direction', () => {
    const minus = feature('study-1:9', 20, -1);
    const forward = render(<ExperimentalTssRendering {...props([minus])} />);
    const forwardGroup = forward.container.querySelector('[data-feature-id="study-1:9"]');
    expect(forwardGroup).toHaveAttribute('data-screen-direction', '-1');
    expect(forward.container.querySelector('[data-role="experimental-tss-flag"]')).toHaveAttribute('fill', MINUS_STRAND_COLOR);
    forward.unmount();

    const reversed = render(<ExperimentalTssRendering {...props([minus], true)} />);
    expect(reversed.container.querySelector('[data-feature-id="study-1:9"]')).toHaveAttribute('data-screen-direction', '1');
    expect(reversed.container.querySelector('[data-role="experimental-tss-flag"]')).toHaveAttribute('fill', MINUS_STRAND_COLOR);
  });

  it('preserves duplicate source rows as separate collision-laid-out glyphs', () => {
    const first = feature('study-1:10', 30, 1);
    const duplicate = feature('study-1:11', 30, 1);
    const featureLayout = layout([0, 24]);
    const { container } = render(<ExperimentalTssRendering {...props([first, duplicate], false, featureLayout)} />);
    expect(container.querySelectorAll('[data-role="experimental-tss-pole"]')).toHaveLength(2);
    expect(featureLayout.addRect).toHaveBeenCalledTimes(2);
    expect(featureLayout.addRect.mock.calls.map((call) => call[0])).toEqual(['study-1:10', 'study-1:11']);
    expect(container.querySelector('svg')).toHaveAttribute('height', '50');
  });

  it('forwards a glyph click with the original stable feature ID', () => {
    const item = feature('study-1:12', 40, 1);
    const onFeatureClick = vi.fn();
    const { container } = render(<ExperimentalTssRendering {...props([item])} onFeatureClick={onFeatureClick} />);
    fireEvent.click(container.querySelector('[data-role="experimental-tss-flag"]')!);
    expect(onFeatureClick).toHaveBeenCalledWith(expect.anything(), 'study-1:12');
  });
});
