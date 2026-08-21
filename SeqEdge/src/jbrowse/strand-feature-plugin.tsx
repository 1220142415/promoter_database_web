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
import { observer } from 'mobx-react';
import {
  DirectionalAnnotationRendering,
  isFormalPromoter,
  promoterAnchorCoordinate,
  PromoterFeatureRendering,
  strandLabel,
} from '@/jbrowse/strand-feature-renderer';

export const PROMOTER_FEATURE_RENDERER = 'SeqEdgePromoterFeatureRenderer';
export const DIRECTIONAL_ANNOTATION_RENDERER = 'SeqEdgeDirectionalAnnotationRenderer';

export type StrandFeatureMode = 'annotation' | 'promoter';

type StrandTooltipModel = {
  featureUnderMouse?: Feature;
};

type StrandTooltipProps = {
  model: StrandTooltipModel;
  clientMouseCoord: [number, number];
};

type DisplayExtensionModel = StrandTooltipModel & {
  TooltipComponent: ComponentType<StrandTooltipProps>;
};

function strandFeatureMode(model: object): StrandFeatureMode | undefined {
  try {
    const track = getContainingTrack(model);
    const metadata = getConf(track, 'metadata') as { seqEdgeStrandFeatureMode?: unknown };
    return metadata.seqEdgeStrandFeatureMode === 'promoter' || metadata.seqEdgeStrandFeatureMode === 'annotation'
      ? metadata.seqEdgeStrandFeatureMode
      : undefined;
  } catch {
    return undefined;
  }
}

function coordinateLabel(feature: Feature) {
  const refName = String(feature.get('refName') || '');
  const start = Number(feature.get('start')) + 1;
  const end = Number(feature.get('end'));
  const startLabel = Number.isFinite(start) ? start.toLocaleString('en-US') : '?';
  const endLabel = Number.isFinite(end) ? end.toLocaleString('en-US') : '?';
  return `${refName}:${startLabel === endLabel ? startLabel : `${startLabel}..${endLabel}`}`;
}

function featureTitle(feature: Feature) {
  return String(feature.get('name') || feature.get('id') || feature.get('type') || 'Feature');
}

function featureScore(feature: Feature) {
  const raw = feature.get('prediction_score') ?? feature.get('score');
  const score = Number(raw);
  return Number.isFinite(score) ? Number(score.toPrecision(6)) : undefined;
}

function isPromoterFeature(feature: Feature, mode?: StrandFeatureMode) {
  const type = String(feature.get('type') || '').toLowerCase();
  return mode === 'promoter' || type === 'promoter' || type === 'promoter_peak';
}

export const StrandFeatureTooltip = observer(function StrandFeatureTooltip({ model, clientMouseCoord }: StrandTooltipProps) {
  const feature = model.featureUnderMouse;
  if (!feature) return null;
  const mode = strandFeatureMode(model as object);
  const promoter = isPromoterFeature(feature, mode);
  // Keep the native score detail for both promoter and NCBI annotation
  // features when the source provides one.
  const score = featureScore(feature);
  const refName = String(feature.get('refName') || '');
  const anchor = promoter && isFormalPromoter(feature) ? promoterAnchorCoordinate(feature) : undefined;
  return (
    <BaseTooltip clientPoint={{ x: clientMouseCoord[0] + 5, y: clientMouseCoord[1] }}>
      <div data-testid="strand-feature-tooltip">
        {featureTitle(feature)}<br />
        {coordinateLabel(feature)}<br />
        {anchor === undefined ? null : <>predicted anchor (80th base): {refName}:{anchor.toLocaleString('en-US')}<br /></>}
        strand: {strandLabel(feature.get('strand'))}
        {score === undefined ? null : <><br />score: {score}</>}
      </div>
    </BaseTooltip>
  );
});

const promoterRendererConfig = ConfigurationSchema(
  PROMOTER_FEATURE_RENDERER,
  {},
  { baseConfiguration: svgFeatureConfigSchema, explicitlyTyped: true },
);

const directionalAnnotationRendererConfig = ConfigurationSchema(
  DIRECTIONAL_ANNOTATION_RENDERER,
  {},
  { baseConfiguration: svgFeatureConfigSchema, explicitlyTyped: true },
);

export default class SeqEdgeStrandFeaturePlugin extends Plugin {
  name = 'SeqEdgeStrandFeaturePlugin';

  install(pluginManager: PluginManager) {
    pluginManager.addRendererType((pm) => new SvgFeatureRenderer({
      name: PROMOTER_FEATURE_RENDERER,
      displayName: 'Predicted promoter anchors and arrows',
      ReactComponent: PromoterFeatureRendering,
      configSchema: promoterRendererConfig,
      pluginManager: pm,
    }));
    pluginManager.addRendererType((pm) => new SvgFeatureRenderer({
      name: DIRECTIONAL_ANNOTATION_RENDERER,
      displayName: 'Directional annotation arrows',
      ReactComponent: DirectionalAnnotationRendering,
      configSchema: directionalAnnotationRendererConfig,
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
              return strandFeatureMode(self) ? StrandFeatureTooltip : NativeTooltip;
            },
          },
        };
      });
      return displayType;
    });
  }
}
