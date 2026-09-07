import type { Metadata } from 'next';
import { PredictionAuthForm } from '@/features/email-system/auth-ui';
import { predictionAccessMode } from '@/features/email-system/access-mode';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Prediction sign in | RAPPTOR',
  robots: { index: false, follow: false },
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (predictionAccessMode() === 'ip') redirect('/predict');
  const requested = (await searchParams).next;
  const nextPath = requested?.startsWith('/predict') ? requested : '/predict';
  return <PredictionAuthForm nextPath={nextPath} />;
}
