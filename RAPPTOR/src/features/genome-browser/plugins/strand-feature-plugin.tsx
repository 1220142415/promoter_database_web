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
import {
  DirectionalAnnotationRendering,
  featureCoordinates,
  predictionAnchorCoordinate,
  predictionSequenceLength,
  promoterDisplayCoordinates,
  PromoterFeatureRendering,
  strandLabel,
} from '@/features/genome-browser/plugins/strand-feature-renderer';

export const PROMOTER_FEATURE_RENDERER = 'RAPPTORPromoterFeatureRenderer';
export const DIRECTIONAL_ANNOTATION_RENDERER = 'RAPPTORDirectionalAnnotationRenderer';

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

type FeatureWidgetModel = {
  type: string;
  featureData?: Record<string, unknown>;
  trackId?: string;
};

type FeatureWidgetProps = {
  model: FeatureWidgetModel;
  session: {
    view?: {
      tracks?: Array<{
        configuration?: { metadata?: unknown; trackId?: unknown };
      }>;
    };
  };
};

function strandFeatureMode(model: object): StrandFeatureMode | undefined {
  try {
    const track = getContainingTrack(model);
    const metadata = getConf(track, 'metadata') as { rapptorStrandFeatureMode?: unknown };
    return metadata.rapptorStrandFeatureMode === 'promoter' || metadata.rapptorStrandFeatureMode === 'annotation'
      ? metadata.rapptorStrandFeatureMode
      : undefined;
  } catch {
    return undefined;
  }
}

function coordinateLabel(feature: Feature, coordinates = featureCoordinates(feature)) {
  const refName = String(feature.get('refName') || '');
  const start = coordinates.start + 1;
  const end = coordinates.end;
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

function featureFromData(data: Record<string, unknown>) {
  return {
    id: () => String(data.id || data.name || data.type || 'feature'),
    get: (key: string) => data[key],
  } as unknown as Feature;
}

function isPromoterFeatureData(data: Record<string, unknown> | undefined) {
  if (!data) return false;
  const type = String(data.type || '').toLowerCase();
  return type === 'promoter' || type === 'promoter_peak';
}

function intervalText(refName: string, start0: number, end0: number) {
  const start = start0 + 1;
  const startLabel = Number.isFinite(start) ? start.toLocaleString('en-US') : '?';
  const endLabel = Number.isFinite(end0) ? end0.toLocaleString('en-US') : '?';
  return `${refName}:${startLabel === endLabel ? startLabel : `${startLabel}..${endLabel}`}`;
}

function widgetSequenceLength(model: FeatureWidgetModel, session: FeatureWidgetProps['session'], refName: string) {
  const track = session.view?.tracks?.find((candidate) => {
    if (candidate.configuration?.trackId === model.trackId) return true;
    try { return getConf(candidate as never, 'trackId') === model.trackId; } catch { return false; }
  });
  if (!track) return undefined;
  let metadata: unknown = track.configuration?.metadata;
  if (!metadata) {
    try { metadata = getConf(track as never, 'metadata'); } catch { return undefined; }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const lengths = (metadata as { rapptorSequenceLengths?: unknown }).rapptorSequenceLengths;
  if (!lengths || typeof lengths !== 'object' || Array.isArray(lengths)) return undefined;
  const length = Number((lengths as Record<string, unknown>)[refName]);
  return Number.isSafeInteger(length) && length >= 1 ? length : undefined;
}

function scoringWindow(data: Record<string, unknown>) {
  const start0 = Number(data.scoring_window_start_0based);
  const end0 = Number(data.scoring_window_end_0based);
  if (Number.isSafeInteger(start0) && Number.isSafeInteger(end0) && start0 >= 0 && end0 > start0) {
    return {
      start: start0,
      end: end0,
      convention: `stored as 0-based half-open ${start0}..${end0}`,
    };
  }
  const start1 = Number(data.scoring_window_start_1based);
  const end1 = Number(data.scoring_window_end_1based);
  if (Number.isSafeInteger(start1) && Number.isSafeInteger(end1) && start1 >= 1 && end1 >= start1) {
    return {
      start: start1 - 1,
      end: end1,
      convention: `stored as 1-based closed ${start1}..${end1}`,
    };
  }
  return undefined;
}

function promoterFeatureDetails(
  Original: ComponentType<FeatureWidgetProps>,
  props: Record<string, unknown>,
) {
  const model = props.model as FeatureWidgetModel | undefined;
  const data = model?.featureData;
  if (model?.type !== 'BaseFeatureWidget' || !isPromoterFeatureData(data)) return Original;
  const feature = featureFromData(data!);
  const source = featureCoordinates(feature);
  const anchor = predictionAnchorCoordinate(feature);
  const refName = String(data!.refName || data!.seq_id || '');
  const storedSequenceLength = Number(data!.sequence_length);
  const scoring = scoringWindow(data!);

  return function PromoterFeatureDetails(featureProps: FeatureWidgetProps) {
    const sequenceLength = Number.isSafeInteger(storedSequenceLength) && storedSequenceLength >= 1
      ? storedSequenceLength
      : widgetSequenceLength(featureProps.model, featureProps.session, refName);
    const display = promoterDisplayCoordinates(feature, sequenceLength);
    const sourceDiffers = source.start !== display.start || source.end !== display.end;
    const displayUnavailable = String(data!.display_interval || '').toLowerCase() === 'unavailable'
      || display.end - display.start === 1;
    return (
      <>
        <Box
          data-testid="promoter-display-details"
          role="note"
          sx={{
            border: '1px solid #b9d8d1',
            borderRadius: 1,
            bgcolor: '#edf7f4',
            color: '#0f4f45',
            fontSize: 13,
            mb: 1,
            px: 1.5,
            py: 1,
          }}
        >
          <strong>Prediction display interval:</strong> {intervalText(refName, display.start, display.end)}
          {displayUnavailable ? ' (anchor only; a complete 100 bp display interval is unavailable at this contig boundary)' : ' (1-based closed; 79 bp upstream, anchor base, 20 bp downstream)'}
          {anchor === undefined ? null : <><br /><strong>Prediction anchor:</strong> {refName}:{anchor.toLocaleString('en-US')}</>}
          {sourceDiffers ? <><br /><strong>Source file interval:</strong> {intervalText(refName, source.start, source.end)} (preserved for file compatibility)</> : null}
          {scoring ? <><br /><strong>Model scoring window:</strong> {intervalText(refName, scoring.start, scoring.end)} ({scoring.convention})</> : null}
        </Box>
        <Original {...featureProps} />
      </>
    );
  };
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
  const sequenceLength = predictionSequenceLength(model as object, String(feature.get('refName') || ''));
  const coordinates = promoter ? promoterDisplayCoordinates(feature, sequenceLength) : featureCoordinates(feature);
  const anchor = promoter ? predictionAnchorCoordinate(feature) : undefined;
  return (
    <BaseTooltip clientPoint={{ x: clientMouseCoord[0] + 5, y: clientMouseCoord[1] }}>
      <div data-testid="strand-feature-tooltip">
        {featureTitle(feature)}<br />
        {coordinateLabel(feature, coordinates)}<br />
        {anchor === undefined ? null : <>prediction anchor: {refName}:{anchor.toLocaleString('en-US')}<br /></>}
        strand: {strandLabel(feature.get('strand'))}
        {score === undefined ? null : <><br />{promoter ? 'model score' : 'score'}: {score}</>}
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

export default class RapptorStrandFeaturePlugin extends Plugin {
  name = 'RAPPTORStrandFeaturePlugin';

  install(pluginManager: PluginManager) {
    pluginManager.addRendererType((pm) => new SvgFeatureRenderer({
      name: PROMOTER_FEATURE_RENDERER,
      displayName: 'Promoter prediction anchors and arrows',
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

    pluginManager.addToExtensionPoint<ComponentType<FeatureWidgetProps>>(
      'Core-replaceWidget',
      promoterFeatureDetails,
    );
  }
}
