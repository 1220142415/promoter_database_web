import type { Metadata } from 'next';
import PredictionWorkbench from '@/features/prediction/components/prediction-workbench';
import { predictionPublicEnabled } from '@/features/prediction/public';
import PrototypePredictionWorkbench from '@/features/prediction/prototype/prototype-workbench';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Promoter prediction | RAPPTOR',
  description: 'Prepare and interpret RAPPtor promoter prediction workflows, with an illustrative local prototype when the queued service is not public.',
};

export default function PredictPage() {
  if (!predictionPublicEnabled()) {
    return <PrototypePredictionWorkbench modelVersion={process.env.RAPPTOR_PREDICTION_MODEL_VERSION || undefined} />;
  }

  return (
    <main className="portal-page">
      <header className="portal-shell page-intro">
        <p className="portal-kicker">Queued GPU inference</p>
        <h1>Run RAPPTOR</h1>
        <p>Submit a complete bacterial genome for CGR-conditioned promoter scoring. Large results stay server-side and BigWig tracks load by byte range.</p>
      </header>
      <PredictionWorkbench
        siteKey={process.env.NEXT_PUBLIC_RAPPTOR_TURNSTILE_SITE_KEY || ''}
        modelVersion={process.env.RAPPTOR_PREDICTION_MODEL_VERSION || 'candidate-github-93cf'}
        localTest={process.env.NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST?.trim().toLowerCase() === 'on'}
      />
    </main>
  );
}
