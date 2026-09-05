import type { Metadata } from 'next';
import PrototypePredictionResultView from '@/features/prediction/prototype-result-view';

export const metadata: Metadata = {
  title: 'Prediction prototype result | RAPPTOR',
  description: 'Demo only: deterministic fixture values; no model was run.',
};

export default async function PrototypePredictionResultPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <PrototypePredictionResultView runId={runId} />;
}
