import type { Metadata } from 'next';
import { PredictionAuthForm } from '@/features/auth/auth-ui';

export const metadata: Metadata = {
  title: 'Prediction sign in | RAPPTOR',
  robots: { index: false, follow: false },
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const requested = (await searchParams).next;
  const nextPath = requested?.startsWith('/predict') ? requested : '/predict';
  return <PredictionAuthForm nextPath={nextPath} />;
}
