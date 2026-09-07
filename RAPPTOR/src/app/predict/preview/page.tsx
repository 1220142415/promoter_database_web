import { notFound } from 'next/navigation';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';

export default function PredictionPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <PrototypePredictionWorkbench preview />;
}
