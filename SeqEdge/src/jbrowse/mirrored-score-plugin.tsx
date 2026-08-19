'use client';

import type { ComponentType } from 'react';
import Plugin from '@jbrowse/core/Plugin';
import type PluginManager from '@jbrowse/core/PluginManager';
import { ConfigurationSchema, getConf } from '@jbrowse/core/configuration';
import type { DisplayType, PluggableElementType } from '@jbrowse/core/pluggableElementTypes';
import { BaseTooltip } from '@jbrowse/core/ui';
import { getContainingTrack } from '@jbrowse/core/util';
import { BaseLinearDisplayComponent } from '@jbrowse/plugin-linear-genome-view';
import { observer } from 'mobx-react';
import {
  MIRRORED_SCORE_HEIGHT,
  MirroredBarsRenderer,
  MirroredLinesRenderer,
  MirroredScoreRendering,
  mirroredFeatureScore,
} from '@/jbrowse/mirrored-score-renderer';

export const MIRRORED_BARS_RENDERER = 'SeqEdgeMirroredBarsRenderer';
export const MIRRORED_LINES_RENDERER = 'SeqEdgeMirroredLinesRenderer';

type MenuItem = {
  label?: string;
  subMenu?: MenuItem[];
  type?: string;
  checked?: boolean;
  onClick?: () => void;
  [key: string]: unknown;
};

type MirroredDisplayModel = {
  height: number;
  rendererTypeNameSimple: string;
  features: Map<string, unknown>;
  featureUnderMouse?: ScoreFeature;
  setFeatureUnderMouse: (feature: unknown) => void;
  setRendererType: (renderer: string) => void;
};

type ScoreFeature = {
  get: (key: string) => unknown;
};

type DisplayExtensionModel = MirroredDisplayModel & {
  renderProps: () => Record<string, unknown>;
  trackMenuItems: () => MenuItem[];
  TooltipComponent: ComponentType<MirroredTooltipProps>;
};

type MirroredTooltipProps = {
  model: MirroredDisplayModel;
  clientMouseCoord: [number, number];
};

function isMirroredScoreDisplay(model: object) {
  try {
    const track = getContainingTrack(model);
    const metadata = getConf(track, 'metadata') as { seqEdgeMirroredScore?: unknown };
    return metadata.seqEdgeMirroredScore === true;
  } catch {
    return false;
  }
}

function coordinateLabel(feature: ScoreFeature) {
  const refName = String(feature.get('refName') || '');
  const start = Number(feature.get('start')) + 1;
  const end = Number(feature.get('end'));
  const span = start === end ? start.toLocaleString('en-US') : `${start.toLocaleString('en-US')}..${end.toLocaleString('en-US')}`;
  return `${refName}:${span}`;
}

export const MirroredScoreTooltip = observer(function MirroredScoreTooltip({ model, clientMouseCoord }: MirroredTooltipProps) {
  const feature = model.featureUnderMouse;
  if (!feature) return null;
  const source = feature.get('source');
  const strand = source === 'minus' ? '-' : '+';
  const score = mirroredFeatureScore(feature as never);
  return (
    <BaseTooltip clientPoint={{ x: clientMouseCoord[0] + 5, y: clientMouseCoord[1] }}>
      <div data-testid="mirrored-score-tooltip">
        {coordinateLabel(feature)}<br />
        strand={strand}<br />
        score={Number(score.toPrecision(6))}
      </div>
    </BaseTooltip>
  );
});

const MirroredDisplayComponent = observer(function MirroredDisplayComponent(props: { model: MirroredDisplayModel }) {
  const { model } = props;
  return (
    <div style={{ position: 'relative', height: model.height }}>
      <BaseLinearDisplayComponent model={model as never} />
      <svg
        aria-hidden="true"
        height={model.height}
        width="100%"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
      >
        <line x1="0" x2="100%" y1={model.height / 2} y2={model.height / 2} stroke="#475569" strokeWidth="1" />
        <g fill="#334155" fontFamily="system-ui, sans-serif" fontSize="10">
          <text x="4" y="11">1</text>
          <text x="4" y={model.height / 2 - 4}>0</text>
          <text x="4" y={model.height - 4}>1</text>
        </g>
      </svg>
    </div>
  );
});

const nativeRendererTypes: Record<string, string> = {
  xyplot: 'MultiXYPlotRenderer',
  multirowxy: 'MultiRowXYPlotRenderer',
  multirowdensity: 'MultiDensityRenderer',
  multiline: 'MultiLineRenderer',
  multirowline: 'MultiRowLineRenderer',
};

const rendererConfig = ConfigurationSchema('SeqEdgeMirroredScoreRendererConfig', {}, { explicitlyTyped: true });

export default class SeqEdgeMirroredScorePlugin extends Plugin {
  name = 'SeqEdgeMirroredScorePlugin';

  install(pluginManager: PluginManager) {
    pluginManager.addRendererType((pm) => new MirroredBarsRenderer({
      name: MIRRORED_BARS_RENDERER,
      displayName: 'Mirrored bars',
      ReactComponent: MirroredScoreRendering,
      configSchema: rendererConfig,
      pluginManager: pm,
    }));
    pluginManager.addRendererType((pm) => new MirroredLinesRenderer({
      name: MIRRORED_LINES_RENDERER,
      displayName: 'Mirrored lines',
      ReactComponent: MirroredScoreRendering,
      configSchema: rendererConfig,
      pluginManager: pm,
    }));

    pluginManager.addToExtensionPoint<PluggableElementType>('Core-extendPluggableElement', (element) => {
      if (element.name !== 'MultiLinearWiggleDisplay') return element;
      const displayType = element as DisplayType;
      const NativeComponent = displayType.ReactComponent as ComponentType<{ model: MirroredDisplayModel }>;
      displayType.ReactComponent = ((props: { model: MirroredDisplayModel }) => (
        isMirroredScoreDisplay(props.model)
          ? <MirroredDisplayComponent {...props} />
          : <NativeComponent {...props} />
      )) as typeof displayType.ReactComponent;

      displayType.stateModel = displayType.stateModel.extend((self) => {
        const previous = self as unknown as DisplayExtensionModel;
        const superRenderProps = previous.renderProps;
        const superTrackMenuItems = previous.trackMenuItems;
        const NativeTooltip = previous.TooltipComponent;
        return {
          views: {
            get rendererTypeName() {
              if (!isMirroredScoreDisplay(self)) {
                return nativeRendererTypes[previous.rendererTypeNameSimple] || 'MultiXYPlotRenderer';
              }
              return previous.rendererTypeNameSimple === 'multiline'
                ? MIRRORED_LINES_RENDERER
                : MIRRORED_BARS_RENDERER;
            },
            get TooltipComponent() {
              return isMirroredScoreDisplay(self) ? MirroredScoreTooltip : NativeTooltip;
            },
            renderProps() {
              const props = superRenderProps();
              if (!isMirroredScoreDisplay(self)) return props;
              return {
                ...props,
                height: MIRRORED_SCORE_HEIGHT,
                onMouseMove: (_event: React.MouseEvent, featureId?: string) => {
                  previous.setFeatureUnderMouse(featureId ? previous.features.get(featureId) : undefined);
                },
                onMouseLeave: () => previous.setFeatureUnderMouse(undefined),
              };
            },
            trackMenuItems() {
              const items = superTrackMenuItems();
              if (!isMirroredScoreDisplay(self)) return items;
              const hidden = new Set([
                'Score',
                'Fill mode',
                'Renderer type',
                'Draw cross hatches',
                'Cluster by score',
                'Show sidebar',
                'Edit colors/arrangement...',
              ]);
              return [
                ...items.filter((item) => !item.label || !hidden.has(item.label)),
                {
                  label: 'Renderer type',
                  subMenu: [
                    { label: 'Mirrored bars', key: 'xyplot' },
                    { label: 'Mirrored lines', key: 'multiline' },
                  ].map(({ label, key }) => ({
                    label,
                    type: 'radio',
                    checked: previous.rendererTypeNameSimple === key,
                    onClick: () => previous.setRendererType(key),
                  })),
                },
              ];
            },
          },
        };
      });
      return displayType;
    });
  }
}
