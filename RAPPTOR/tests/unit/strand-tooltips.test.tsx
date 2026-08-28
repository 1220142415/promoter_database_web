// @vitest-environment jsdom

import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Feature } from '@jbrowse/core/util';
import { MirroredScoreTooltip } from '@/features/genome-browser/plugins/mirrored-score-plugin';
import { StrandFeatureTooltip } from '@/features/genome-browser/plugins/strand-feature-plugin';

function feature(data: Record<string, unknown>) {
  return {
    id: () => String(data.id || 'feature'),
    get: (key: string) => data[key],
  } as unknown as Feature;
}

describe('strand tooltips', () => {
  it('uses the explicit strand label for mirrored quantitative scores', () => {
    const props = {
      clientMouseCoord: [10, 10],
      model: {
        featureUnderMouse: feature({
          refName: 'contig_1',
          start: 19,
          end: 20,
          source: 'minus',
          score: 0.91,
        }),
      },
    } as unknown as ComponentProps<typeof MirroredScoreTooltip>;
    render(<MirroredScoreTooltip {...props} />);
    expect(screen.getByTestId('mirrored-score-tooltip')).toHaveTextContent('strand: -');
  });

  it('always shows strand and coordinates for feature tracks', () => {
    const plusProps = {
      clientMouseCoord: [10, 10],
      model: {
        featureUnderMouse: feature({
          id: 'promoter-1',
          refName: 'contig_1',
          start: 19,
          end: 119,
          strand: 1,
          type: 'promoter',
          prediction_score: 0.95,
        }),
      },
    } as ComponentProps<typeof StrandFeatureTooltip>;
    const { rerender } = render(<StrandFeatureTooltip {...plusProps} />);
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('contig_1:20..119');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('prediction class: predicted promoter interval');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('sequence: contig_1');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('predicted anchor (80th base): contig_1:99');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('strand: +');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('model score: 0.95');

    const unknownProps = {
      clientMouseCoord: [10, 10],
      model: {
        featureUnderMouse: feature({
          id: 'region-1',
          refName: 'contig_1',
          start: 29,
          end: 40,
          strand: 0,
          type: 'region',
        }),
      },
    } as ComponentProps<typeof StrandFeatureTooltip>;
    rerender(<StrandFeatureTooltip {...unknownProps} />);
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('strand: unknown');
  });

  it('shows the exact 1-based coordinate and model score for point predictions', () => {
    const props = {
      clientMouseCoord: [10, 10],
      model: {
        featureUnderMouse: feature({
          id: 'legacy-peak',
          refName: 'contig_1',
          start: 19,
          end: 20,
          strand: -1,
          type: 'promoter_peak',
          score: 0.91,
        }),
      },
    } as ComponentProps<typeof StrandFeatureTooltip>;
    render(<StrandFeatureTooltip {...props} />);
    expect(screen.getByTestId('strand-feature-tooltip')).not.toHaveTextContent('predicted anchor');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('prediction class: predicted promoter peak');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('sequence: contig_1');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('predicted peak: contig_1:20');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('strand: -');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('model score: 0.91');
  });

  it('shows study provenance for experimental TSS without exposing the BED score', () => {
    const props = {
      clientMouseCoord: [10, 10],
      model: {
        featureUnderMouse: feature({
          id: 'experimental_tss_000001',
          refName: 'NC_003272.1',
          start: 99,
          end: 100,
          strand: 1,
          type: 'experimental_tss',
          study_id: '2011_22135468_GCF_000009705.1',
          pmid: '22135468',
          source_name: 'atpH',
          source_signal: '42',
          score: 42,
        }),
      },
    } as ComponentProps<typeof StrandFeatureTooltip>;
    render(<StrandFeatureTooltip {...props} />);

    const tooltip = screen.getByTestId('strand-feature-tooltip');
    expect(tooltip).toHaveTextContent('evidence: experimentally supported TSS observation');
    expect(tooltip).toHaveTextContent('sequence: NC_003272.1');
    expect(tooltip).toHaveTextContent('NC_003272.1:100');
    expect(tooltip).toHaveTextContent('strand: +');
    expect(tooltip).toHaveTextContent('study: 2011_22135468_GCF_000009705.1');
    expect(tooltip).toHaveTextContent('PMID: 22135468');
    expect(tooltip).toHaveTextContent('source identifier: atpH');
    expect(tooltip).not.toHaveTextContent('source signal');
    expect(tooltip).not.toHaveTextContent('score');
    expect(tooltip).not.toHaveTextContent('model score');
    expect(tooltip).not.toHaveTextContent('prediction class');
  });
});
