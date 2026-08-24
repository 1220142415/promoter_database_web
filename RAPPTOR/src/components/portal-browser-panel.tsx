'use client';

import dynamic from 'next/dynamic';
import type { JBrowseReleaseAssembly } from '@/types/release';
import type { BrowserRegion } from '@/components/portal-jbrowse-viewer';

const PortalJBrowseViewer = dynamic(() => import('@/components/portal-jbrowse-viewer'), {
  ssr: false,
  loading: () => <div className="browser-loading" role="status">Loading genome browser...</div>,
});

export default function PortalBrowserPanel({ assembly, onRegionChange }: { assembly: JBrowseReleaseAssembly; onRegionChange?: (region: BrowserRegion) => void }) {
  return <PortalJBrowseViewer assembly={assembly} onRegionChange={onRegionChange} />;
}
