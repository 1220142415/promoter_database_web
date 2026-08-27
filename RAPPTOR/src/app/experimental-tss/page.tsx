import { notFound, permanentRedirect } from 'next/navigation';
import { experimentalTssPublicEnabled } from '@/features/genome-browser/experimental-tss-public';

export default function ExperimentalTssPage() {
  if (!experimentalTssPublicEnabled()) notFound();
  return permanentRedirect('/genomes?evidence=experimental');
}
