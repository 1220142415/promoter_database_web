// @vitest-environment jsdom

import type { ComponentType } from 'react';
import { render, screen } from '@testing-library/react';
import type PluginManager from '@jbrowse/core/PluginManager';
import type { Feature } from '@jbrowse/core/util';
import { describe, expect, it, vi } from 'vitest';
import RapptorExperimentalTssPlugin, { ExperimentalTssTooltip } from '@/features/genome-browser/plugins/experimental-tss-plugin';

describe('experimental TSS plugin', () => {
  it('labels experimental BaseFeatureWidget content while preserving native details', () => {
    type WidgetTestProps = {
      model: { type: string; featureData: Record<string, unknown> };
      session: unknown;
    };
    const extensionPoints = new Map<string, (
      component: ComponentType<WidgetTestProps>,
      props: Record<string, unknown>,
    ) => ComponentType<WidgetTestProps>>();
    const manager = {
      addRendererType: vi.fn(),
      addToExtensionPoint: vi.fn((name: string, callback: typeof extensionPoints extends Map<string, infer T> ? T : never) => {
        extensionPoints.set(name, callback);
      }),
    } as unknown as PluginManager;
    new RapptorExperimentalTssPlugin().install(manager);
    const replaceWidget = extensionPoints.get('Core-replaceWidget')!;
    const model = {
      type: 'BaseFeatureWidget',
      featureData: {
        type: 'experimental_TSS',
        evidence_type: 'experimental',
        source_row: 17,
        pmid: '22251276',
      },
    };
    const Native = (() => <div>native feature fields</div>) as ComponentType<WidgetTestProps>;
    const Wrapped = replaceWidget(Native, { model });
    render(<Wrapped model={model} session={{}} />);
    expect(screen.getByRole('note')).toHaveTextContent('Experimental TSS · one original observation');
    expect(screen.getByText('native feature fields')).toBeInTheDocument();
  });

  it('shows exact coordinate and study provenance in the experimental tooltip', () => {
    const data: Record<string, unknown> = {
      id: '2012_22251276_GCF_000210855.2:17',
      name: 'original-row-17',
      refName: 'NC_016810.1',
      start: 99,
      end: 100,
      strand: -1,
      study_id: '2012_22251276_GCF_000210855.2',
      pmid: '22251276',
    };
    const feature = {
      id: () => String(data.id),
      get: (key: string) => data[key],
    } as unknown as Feature;
    render(<ExperimentalTssTooltip model={{ featureUnderMouse: feature }} clientMouseCoord={[10, 20]} />);
    expect(screen.getByTestId('experimental-tss-tooltip')).toHaveTextContent('Experimental TSS');
    expect(screen.getByTestId('experimental-tss-tooltip')).toHaveTextContent('NC_016810.1:100');
    expect(screen.getByTestId('experimental-tss-tooltip')).toHaveTextContent('strand: -');
    expect(screen.getByTestId('experimental-tss-tooltip')).toHaveTextContent('PMID: 22251276');
    expect(screen.getByTestId('experimental-tss-tooltip').querySelector('a')).toHaveAttribute('href', 'https://pubmed.ncbi.nlm.nih.gov/22251276/');
  });
});
