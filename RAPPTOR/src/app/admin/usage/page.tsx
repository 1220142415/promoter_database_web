import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import UsageDashboard from '@/features/usage/components/usage-dashboard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Usage | RAPPTOR',
  robots: { index: false, follow: false },
};

export default async function UsageDashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!process.env.RAPPTOR_ANALYTICS_USERNAME || !process.env.RAPPTOR_ANALYTICS_PASSWORD) notFound();
  return UsageDashboard({ searchParams });
}
