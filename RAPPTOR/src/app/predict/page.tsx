import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import PredictionWorkbench from '@/features/prediction/components/prediction-workbench';
import { predictionPublicEnabled } from '@/features/prediction/public';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Run RAPPTOR | RAPPTOR' };

export default function PredictPage() {
  if (!predictionPublicEnabled()) notFound();
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
