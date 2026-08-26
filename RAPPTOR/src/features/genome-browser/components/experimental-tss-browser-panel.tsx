'use client';

import dynamic from 'next/dynamic';
import type { ExperimentalTssGenome } from '@/types/experimental-tss';

const ExperimentalTssJBrowseViewer = dynamic(
  () => import('@/features/genome-browser/components/experimental-tss-jbrowse-viewer'),
  {
    ssr: false,
    loading: () => <div className="browser-loading" role="status">Loading experimental TSS browser...</div>,
  },
);

export default function ExperimentalTssBrowserPanel({ genome }: { genome: ExperimentalTssGenome }) {
  return <ExperimentalTssJBrowseViewer genome={genome} />;
}
