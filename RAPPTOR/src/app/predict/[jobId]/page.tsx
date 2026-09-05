import type { Metadata } from 'next';
import PredictionResultView from '@/features/prediction/components/prediction-result-view';

export const metadata: Metadata = {
  title: 'Promoter prediction result | RAPPTOR',
  description: 'RAPPTOR promoter prediction status and result.',
};

export default async function PredictionResultPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <PredictionResultView jobId={jobId} />;
}
