import type { Metadata } from 'next';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';

export const metadata: Metadata = {
  title: 'Promoter prediction prototype | RAPPTOR',
  description: 'Prepare and interpret illustrative RAPPtor candidate-region and whole-genome prediction workflows.',
};

export default function PredictionPrototypePage() {
  return <PrototypePredictionWorkbench />;
}
