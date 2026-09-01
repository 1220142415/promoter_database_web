import type { Metadata } from 'next';
import PrototypePredictionResultView from '@/features/prediction/prototype-result-view';

export const metadata: Metadata = {
  title: 'Prediction prototype result | RAPPTOR',
  description: 'Deterministic RAPPTOR prediction interface fixture. No model is run.',
};

export default async function PrototypePredictionResultPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <PrototypePredictionResultView runId={runId} />;
}
