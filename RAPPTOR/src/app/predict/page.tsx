import type { Metadata } from 'next';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';
import { predictionCapabilities } from '@/features/prediction/capabilities';

export const metadata: Metadata = {
  title: 'Promoter prediction | RAPPTOR',
  description: 'Score a sequence or genome with RAPPTOR.',
};

export default function PredictPage() {
  const capabilities = predictionCapabilities();
  return <PrototypePredictionWorkbench
    modelVersion={process.env.RAPPTOR_PREDICTION_MODEL_VERSION || undefined}
    maxGenomeBytes={capabilities.limits.genomeMaxBytes}
    localTest={process.env.NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST?.trim().toLowerCase() === 'on'}
  />;
}
