import type { Metadata } from 'next';
import PredictionWorkbench from '@/features/prediction/components/prediction-workbench';
import { predictionCapabilities } from '@/features/prediction/capabilities';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Prediction task | RAPPTOR',
  robots: { index: false, follow: false },
};

export default function PredictionTaskPage() {
  const capabilities = predictionCapabilities();
  return (
    <main className="portal-page">
      <PredictionWorkbench
        siteKey={process.env.NEXT_PUBLIC_RAPPTOR_TURNSTILE_SITE_KEY || ''}
        modelVersion={process.env.RAPPTOR_PREDICTION_MODEL_VERSION || 'candidate-github-93cf'}
        maxGenomeBytes={capabilities.limits.genomeMaxBytes}
        localTest={process.env.NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST?.trim().toLowerCase() === 'on'}
      />
    </main>
  );
}
