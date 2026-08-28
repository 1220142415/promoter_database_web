'use client';

import dynamic from 'next/dynamic';
import type { ExperimentalTssGenome } from '@/types/experimental-tss';
import type { JBrowseReleaseAssembly } from '@/types/release';
import type { BrowserRegion } from '@/features/genome-browser/components/unified-jbrowse-viewer';

const UnifiedJBrowseViewer = dynamic(() => import('@/features/genome-browser/components/unified-jbrowse-viewer'), {
  ssr: false,
  loading: () => <div className="browser-loading" role="status">Loading genome browser...</div>,
});

export default function UnifiedBrowserPanel({
  prediction,
  experimental,
  onRegionChange,
}: {
  prediction?: JBrowseReleaseAssembly | null;
  experimental?: ExperimentalTssGenome | null;
  onRegionChange?: (region: BrowserRegion) => void;
}) {
  return <UnifiedJBrowseViewer prediction={prediction} experimental={experimental} onRegionChange={onRegionChange} />;
}
