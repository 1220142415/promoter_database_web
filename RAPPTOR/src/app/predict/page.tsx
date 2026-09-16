import type { Metadata } from 'next';
import { predictionAccessMode } from '@/features/email-system/access-mode';
import { PredictionAuthGate } from '@/features/email-system/auth-ui';
import { headers } from 'next/headers';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';
import { predictionCapabilities } from '@/features/prediction/capabilities';
import { queuedPredictionCapabilities, queuedPredictionLocalTest } from '@/features/prediction/service-capabilities';
import { readPredictionServerStatus } from '@/features/prediction/service-status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Promoter prediction | RAPPTOR',
  description: 'Score a sequence or genome with RAPPTOR.',
};

export default async function PredictPage() {
  const capabilities = predictionCapabilities();
  const localTest = queuedPredictionLocalTest(await headers());
  const [service, serverStatus] = await Promise.all([queuedPredictionCapabilities(localTest), readPredictionServerStatus()]);
  const accessMode = predictionAccessMode();
  const workbench = <PrototypePredictionWorkbench
    modelVersion={service.modelVersion}
    service={service}
    serverStatus={serverStatus}
    maxSequenceBases={capabilities.limits.targetMaxBases}
    maxGenomeBytes={capabilities.limits.genomeMaxBytes}
    localTest={localTest}
  />;
  return !localTest && accessMode === 'email' ? <PredictionAuthGate>{workbench}</PredictionAuthGate> : workbench;
}
