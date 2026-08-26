'use client';

import type { ComponentType } from 'react';
import Plugin from '@jbrowse/core/Plugin';
import type PluginManager from '@jbrowse/core/PluginManager';
import { ConfigurationSchema, getConf } from '@jbrowse/core/configuration';
import { type DisplayType, type PluggableElementType } from '@jbrowse/core/pluggableElementTypes';
import { BaseTooltip } from '@jbrowse/core/ui';
import { getContainingTrack, type Feature } from '@jbrowse/core/util';
import SvgFeatureRenderer from '@jbrowse/plugin-svg/esm/SvgFeatureRenderer/SvgFeatureRenderer.js';
import { configSchema as svgFeatureConfigSchema } from '@jbrowse/plugin-svg/esm/SvgFeatureRenderer/index.js';
import { Box } from '@mui/material';
import { observer } from 'mobx-react';
import { ExperimentalTssRendering, experimentalTssCoordinate } from '@/features/genome-browser/plugins/experimental-tss-renderer';
import { strandLabel } from '@/features/genome-browser/plugins/strand-feature-renderer';

export const EXPERIMENTAL_TSS_RENDERER = 'RAPPTORExperimentalTssRenderer';

type ExperimentalTooltipModel = { featureUnderMouse?: Feature };
type ExperimentalTooltipProps = { model: ExperimentalTooltipModel; clientMouseCoord: [number, number] };
type DisplayExtensionModel = ExperimentalTooltipModel & { TooltipComponent: ComponentType<ExperimentalTooltipProps> };

type FeatureWidgetModel = {
  type?: string;
  featureData?: Record<string, unknown>;
};

type FeatureWidgetProps = {
  model: FeatureWidgetModel;
  session: unknown;
  overrideDimensions?: { height: number; width: number };
};

function isExperimentalDisplay(model: object) {
  try {
    const track = getContainingTrack(model);
    const metadata = getConf(track, 'metadata') as { rapptorEvidenceType?: unknown };
    return metadata.rapptorEvidenceType === 'experimental_tss';
  } catch {
    return false;
  }
}

function field(feature: Feature, name: string) {
  const value = feature.get(name);
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

export const ExperimentalTssTooltip = observer(function ExperimentalTssTooltip({
  model,
  clientMouseCoord,
}: ExperimentalTooltipProps) {
  const feature = model.featureUnderMouse;
  if (!feature) return null;
  const refName = String(feature.get('refName') || '');
  const study = field(feature, 'study_id');
  const pmid = field(feature, 'pmid');
  const name = field(feature, 'name') || field(feature, 'id');
  return (
    <BaseTooltip clientPoint={{ x: clientMouseCoord[0] + 5, y: clientMouseCoord[1] }}>
      <div data-testid="experimental-tss-tooltip">
        <strong>Experimental TSS</strong><br />
        {name ? <>{name}<br /></> : null}
        {refName}:{experimentalTssCoordinate(feature).toLocaleString('en-US')}<br />
        strand: {strandLabel(feature.get('strand'))}
        {study ? <><br />study: {study}</> : null}
        {pmid ? <><br />PMID: {pmid}</> : null}
      </div>
    </BaseTooltip>
  );
});

function isExperimentalFeatureData(featureData: Record<string, unknown> | undefined) {
  if (!featureData) return false;
  return featureData.evidence_type === 'experimental'
    || String(featureData.type || '').toLowerCase().replaceAll('_', '-') === 'experimental-tss';
}

function experimentalFeatureDetails(
  Original: ComponentType<FeatureWidgetProps>,
  props: Record<string, unknown>,
) {
  const model = props.model as FeatureWidgetModel | undefined;
  if (model?.type !== 'BaseFeatureWidget' || !isExperimentalFeatureData(model.featureData)) return Original;
  return function ExperimentalFeatureDetails(featureProps: FeatureWidgetProps) {
    return (
      <>
        <Box
          data-testid="experimental-tss-details-label"
          role="note"
          sx={{
            border: '1px solid #b9d8d1',
            borderRadius: 1,
            bgcolor: '#edf7f4',
            color: '#0f4f45',
            fontSize: 13,
            fontWeight: 750,
            mb: 1,
            px: 1.5,
            py: 1,
          }}
        >
          Experimental TSS · one original observation
        </Box>
        <Original {...featureProps} />
      </>
    );
  };
}

const experimentalRendererConfig = ConfigurationSchema(
  EXPERIMENTAL_TSS_RENDERER,
  {},
  { baseConfiguration: svgFeatureConfigSchema, explicitlyTyped: true },
);

export default class RapptorExperimentalTssPlugin extends Plugin {
  name = 'RAPPTORExperimentalTssPlugin';

  install(pluginManager: PluginManager) {
    pluginManager.addRendererType((pm) => new SvgFeatureRenderer({
      name: EXPERIMENTAL_TSS_RENDERER,
      displayName: 'Experimental TSS flags',
      ReactComponent: ExperimentalTssRendering,
      configSchema: experimentalRendererConfig,
      pluginManager: pm,
    }));

    pluginManager.addToExtensionPoint<PluggableElementType>('Core-extendPluggableElement', (element) => {
      if (element.name !== 'LinearBasicDisplay') return element;
      const displayType = element as DisplayType;
      displayType.stateModel = displayType.stateModel.extend((self) => {
        const previous = self as unknown as DisplayExtensionModel;
        const NativeTooltip = previous.TooltipComponent;
        return {
          views: {
            get TooltipComponent() {
              return isExperimentalDisplay(self) ? ExperimentalTssTooltip : NativeTooltip;
            },
          },
        };
      });
      return displayType;
    });

    pluginManager.addToExtensionPoint<ComponentType<FeatureWidgetProps>>(
      'Core-replaceWidget',
      experimentalFeatureDetails,
    );
  }
}
