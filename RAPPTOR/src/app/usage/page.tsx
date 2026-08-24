import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import UsageDashboard from '@/features/usage/components/usage-dashboard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Usage | RAPPTOR',
  robots: { index: false, follow: false },
};

export default async function PublicUsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.RAPPTOR_USAGE_PUBLIC_PAGE?.toLowerCase() !== 'on') notFound();
  return UsageDashboard({ searchParams, publicView: true });
}
