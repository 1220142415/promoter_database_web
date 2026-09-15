import type { Metadata } from 'next';
import { predictionAccessMode } from '@/features/email-system/access-mode';
import PredictionWorkbench from '@/features/prediction/components/prediction-workbench';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Prediction task | RAPPTOR',
  robots: { index: false, follow: false },
};

export default async function PredictionTaskPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return (
    <PredictionWorkbench initialJobId={jobId} emailNotification={predictionAccessMode() === 'email'} />
  );
}
