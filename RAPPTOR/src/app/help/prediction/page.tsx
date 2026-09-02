import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Not found | RAPPTOR',
  robots: { index: false, follow: false },
};

export default function PredictionHelpPage() {
  return notFound();
}
