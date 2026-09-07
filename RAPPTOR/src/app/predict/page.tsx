import type { Metadata } from 'next';
import { headers } from 'next/headers';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';
import { predictionCapabilities } from '@/features/prediction/capabilities';
import { queuedPredictionCapabilities, queuedPredictionLocalTest } from '@/features/prediction/service-capabilities';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Promoter prediction | RAPPTOR',
  description: 'Score a sequence or genome with RAPPTOR.',
};

export default async function PredictPage() {
  const capabilities = predictionCapabilities();
  const localTest = queuedPredictionLocalTest(await headers());
  const service = await queuedPredictionCapabilities(localTest);
  return <PrototypePredictionWorkbench
    modelVersion={service.modelVersion}
    service={service}
    maxGenomeBytes={capabilities.limits.genomeMaxBytes}
    localTest={localTest}
  />;
}
