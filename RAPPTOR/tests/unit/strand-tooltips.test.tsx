// @vitest-environment jsdom

import type { ComponentProps, ComponentType } from 'react';
import { render, screen } from '@testing-library/react';
import type PluginManager from '@jbrowse/core/PluginManager';
import { describe, expect, it } from 'vitest';
import type { Feature } from '@jbrowse/core/util';
import { MirroredScoreTooltip } from '@/features/genome-browser/plugins/mirrored-score-plugin';
import RapptorStrandFeaturePlugin, { StrandFeatureTooltip } from '@/features/genome-browser/plugins/strand-feature-plugin';

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
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('prediction anchor: contig_1:99');
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

  it('expands legacy point peaks and retains their exact anchor', () => {
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
          peak_position: 20,
        }),
      },
    } as ComponentProps<typeof StrandFeatureTooltip>;
    render(<StrandFeatureTooltip {...props} />);
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('contig_1:20');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('prediction anchor: contig_1:20');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('strand: -');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('model score: 0.91');
  });

  it('shows the 100 bp interval and explicit anchor for new peak artifacts', () => {
    const props = {
      clientMouseCoord: [10, 10],
      model: {
        featureUnderMouse: feature({
          id: 'peak-window', refName: 'contig_1', start: 21, end: 121,
          strand: 1, type: 'promoter_peak', prediction_score: 0.95,
          peak_position: 101, anchor_position_0based: 100, display_interval: 'available',
        }),
      },
    } as ComponentProps<typeof StrandFeatureTooltip>;
    render(<StrandFeatureTooltip {...props} />);
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('contig_1:22..121');
    expect(screen.getByTestId('strand-feature-tooltip')).toHaveTextContent('prediction anchor: contig_1:101');
  });

  it('distinguishes display, source, and model-scoring intervals in feature details', () => {
    type WidgetTestProps = {
      model: { type: string; featureData: Record<string, unknown>; trackId?: string };
      session: { view?: { tracks?: Array<{ configuration?: { metadata?: unknown; trackId?: unknown } }> } };
    };
    const extensionPoints = new Map<string, (
      component: ComponentType<WidgetTestProps>,
      props: Record<string, unknown>,
    ) => ComponentType<WidgetTestProps>>();
    const manager = {
      addRendererType: () => undefined,
      addToExtensionPoint: (name: string, callback: typeof extensionPoints extends Map<string, infer T> ? T : never) => {
        extensionPoints.set(name, callback);
      },
    } as unknown as PluginManager;
    new RapptorStrandFeaturePlugin().install(manager);
    const replaceWidget = extensionPoints.get('Core-replaceWidget')!;
    const model = {
      type: 'BaseFeatureWidget',
      featureData: {
        id: 'promoter_peak_000000005',
        type: 'promoter_peak',
        refName: 'contig_1',
        start: 6462,
        end: 6562,
        strand: -1,
        peak_position: 6482,
        scoring_window_start_0based: 6462,
        scoring_window_end_0based: 6562,
      },
    };
    const Native = (() => <div>native feature fields</div>) as ComponentType<WidgetTestProps>;
    const Wrapped = replaceWidget(Native, { model });
    render(<Wrapped model={model} session={{}} />);

    const note = screen.getByTestId('promoter-display-details');
    expect(note).toHaveTextContent('Prediction display interval: contig_1:6,462..6,561');
    expect(note).toHaveTextContent('Prediction anchor: contig_1:6,482');
    expect(note).toHaveTextContent('Source file interval: contig_1:6,463..6,562');
    expect(note).toHaveTextContent('Model scoring window: contig_1:6,463..6,562');
    expect(screen.getByText('native feature fields')).toBeInTheDocument();
  });

  it('uses track sequence lengths at legacy boundaries and reads 1-based scoring windows', () => {
    type WidgetTestProps = {
      model: { type: string; featureData: Record<string, unknown>; trackId?: string };
      session: { view?: { tracks?: Array<{ configuration?: { metadata?: unknown; trackId?: unknown } }> } };
    };
    const extensionPoints = new Map<string, (
      component: ComponentType<WidgetTestProps>,
      props: Record<string, unknown>,
    ) => ComponentType<WidgetTestProps>>();
    const manager = {
      addRendererType: () => undefined,
      addToExtensionPoint: (name: string, callback: typeof extensionPoints extends Map<string, infer T> ? T : never) => {
        extensionPoints.set(name, callback);
      },
    } as unknown as PluginManager;
    new RapptorStrandFeaturePlugin().install(manager);
    const replaceWidget = extensionPoints.get('Core-replaceWidget')!;
    const model = {
      type: 'BaseFeatureWidget',
      trackId: 'prediction-track',
      featureData: {
        id: 'boundary-peak',
        type: 'promoter_peak',
        refName: 'short_contig',
        start: 19,
        end: 119,
        strand: 1,
        peak_position: 99,
        scoring_window_start_1based: 20,
        scoring_window_end_1based: 119,
        scoring_window_coordinate_system: '1-based_closed',
      },
    };
    const session = {
      view: {
        tracks: [{
          configuration: {
            trackId: 'prediction-track',
            metadata: { rapptorSequenceLengths: { short_contig: 100 } },
          },
        }],
      },
    };
    const Native = (() => <div>native boundary fields</div>) as ComponentType<WidgetTestProps>;
    const Wrapped = replaceWidget(Native, { model });
    render(<Wrapped model={model} session={session} />);

    const note = screen.getByTestId('promoter-display-details');
    expect(note).toHaveTextContent('Prediction display interval: short_contig:99');
    expect(note).toHaveTextContent('anchor only; a complete 100 bp display interval is unavailable');
    expect(note).toHaveTextContent('Model scoring window: short_contig:20..119');
    expect(note).toHaveTextContent('stored as 1-based closed 20..119');
    expect(screen.getByText('native boundary fields')).toBeInTheDocument();
  });
});
