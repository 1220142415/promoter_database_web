import type { Metadata } from 'next';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';

export const metadata: Metadata = {
  title: 'Promoter prediction | RAPPTOR',
  description: 'Submit candidate-region and whole-genome RAPPtor prediction workflows.',
};

export default function PredictPage() {
  return <PrototypePredictionWorkbench
    modelVersion={process.env.RAPPTOR_PREDICTION_MODEL_VERSION || undefined}
    localTest={process.env.NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST?.trim().toLowerCase() === 'on'}
  />;
}
