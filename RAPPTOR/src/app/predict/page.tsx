import type { Metadata } from 'next';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';

export const metadata: Metadata = {
  title: 'Promoter prediction | RAPPTOR',
  description: 'Prepare and interpret illustrative RAPPtor candidate-region and whole-genome prediction workflows.',
};

export default function PredictPage() {
  return <PrototypePredictionWorkbench modelVersion={process.env.RAPPTOR_PREDICTION_MODEL_VERSION || undefined} />;
}
