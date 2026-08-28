'use client';

import dynamic from 'next/dynamic';
import type { JBrowseAssemblyConfig } from '@/features/genome-browser/types';
import type { BrowserRegion } from '@/features/genome-browser/components/portal-jbrowse-viewer';

const PortalJBrowseViewer = dynamic(() => import('@/features/genome-browser/components/portal-jbrowse-viewer'), {
  ssr: false,
  loading: () => <div className="browser-loading" role="status">Loading genome browser...</div>,
});

export default function PortalBrowserPanel({ assembly, onRegionChange }: { assembly: JBrowseAssemblyConfig; onRegionChange?: (region: BrowserRegion) => void }) {
  return <PortalJBrowseViewer assembly={assembly} onRegionChange={onRegionChange} />;
}
