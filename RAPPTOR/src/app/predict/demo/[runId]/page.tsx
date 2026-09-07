import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import PrototypePredictionResultView from '@/features/prediction/prototype-result-view';

export const metadata: Metadata = {
  title: 'Prediction prototype result | RAPPTOR',
  description: 'Demo only: deterministic fixture values; no model was run.',
};

export default async function PrototypePredictionResultPage({ params }: { params: Promise<{ runId: string }> }) {
  if (process.env.NODE_ENV !== 'development') notFound();
  const { runId } = await params;
  return <PrototypePredictionResultView runId={runId} />;
}
