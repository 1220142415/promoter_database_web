import { permanentRedirect } from 'next/navigation';

export default function ExperimentalTssPage() {
  return permanentRedirect('/genomes?evidence=experimental');
}
