'use client';

import { Suspense, type ComponentType } from 'react';
import { readConfObject } from '@jbrowse/core/configuration';
import { LoadingEllipses, createJBrowseTheme } from '@jbrowse/core/ui';
import { EmbeddedViewContainer, ModalWidget } from '@jbrowse/embedded-core';
import { type ViewModel } from '@jbrowse/react-linear-genome-view';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { IconButton, Paper, ThemeProvider, Toolbar, Typography } from '@mui/material';
import { observer } from 'mobx-react';
import { getEnv, type IAnyStateTreeNode } from 'mobx-state-tree';

type VisibleWidget = IAnyStateTreeNode & {
  id: string;
  type: string;
};

type WidgetSession = ViewModel['session'] & {
  visibleWidget?: VisibleWidget;
  hideAllWidgets: () => void;
};

type WidgetComponentProps = {
  model: VisibleWidget;
  session: WidgetSession;
  overrideDimensions?: {
    height: number;
    width: number;
  };
};

const RapptorFeatureDetailsPanel = observer(function RapptorFeatureDetailsPanel({
  session,
  widget,
}: {
  session: WidgetSession;
  widget: VisibleWidget;
}) {
  const { pluginManager } = getEnv(session);
  const { ReactComponent, HeadingComponent, heading } = pluginManager.getWidgetType(widget.type);
  const Component = pluginManager.evaluateExtensionPoint('Core-replaceWidget', ReactComponent, {
    session,
    model: widget,
  }) as ComponentType<WidgetComponentProps>;

  return (
    <Paper
      component="aside"
      className="rapptor-feature-details"
      data-testid="rapptor-feature-details-panel"
      aria-label="Feature details"
      elevation={0}
    >
      <Toolbar className="rapptor-feature-details-header" disableGutters>
        <div className="rapptor-feature-details-heading">
          {HeadingComponent
            ? <HeadingComponent model={widget} />
            : <Typography component="h2" variant="h6">{heading || 'Feature details'}</Typography>}
        </div>
        <IconButton
          aria-label="Close feature details"
          onClick={() => session.hideAllWidgets()}
          size="small"
        >
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Toolbar>
      <div className="rapptor-feature-details-content">
        <Suspense fallback={<div className="rapptor-feature-details-loading"><LoadingEllipses /></div>}>
          <Component
            model={widget}
            session={session}
            overrideDimensions={{ height: 640, width: 384 }}
          />
        </Suspense>
      </div>
    </Paper>
  );
});

const RapptorJBrowseLinearView = observer(function RapptorJBrowseLinearView({
  viewState,
}: {
  viewState: ViewModel;
}) {
  const session = viewState.session as WidgetSession;
  const { view } = session;
  const { pluginManager } = getEnv(session);
  const { ReactComponent } = pluginManager.getViewType(view.type);
  const ViewComponent = ReactComponent as ComponentType<{ model: typeof view; session: WidgetSession }>;
  const detailsWidget = session.visibleWidget?.type === 'BaseFeatureWidget'
    ? session.visibleWidget
    : undefined;
  const theme = createJBrowseTheme(readConfObject(viewState.config.configuration, 'theme'));

  return (
    <ThemeProvider theme={theme}>
      <div className={`rapptor-jbrowse-layout${detailsWidget ? ' rapptor-jbrowse-layout--details' : ''}`}>
        <div className="rapptor-jbrowse-view">
          <EmbeddedViewContainer view={view}>
            <Suspense fallback={<LoadingEllipses />}>
              <ViewComponent model={view} session={session} />
            </Suspense>
          </EmbeddedViewContainer>
        </div>
        {detailsWidget && <RapptorFeatureDetailsPanel session={session} widget={detailsWidget} />}
      </div>
      {!detailsWidget && <ModalWidget session={session as never} />}
    </ThemeProvider>
  );
});

export default RapptorJBrowseLinearView;
