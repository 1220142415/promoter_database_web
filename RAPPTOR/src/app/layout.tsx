import type { Metadata } from 'next';
import Link from 'next/link';
import PortalHeader from '@/components/portal-header';
import { experimentalTssPublicEnabled } from '@/features/genome-browser/experimental-tss-public';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'RAPPTOR | Bacterial promoter resource', template: '%s' },
  description: 'Genome-resolved bacterial promoter predictions, reference assemblies and contextual NCBI annotations.',
  keywords: ['bacterial promoters', 'RAPPTOR', 'GTDB taxonomy', 'genome browser', 'JBrowse 2'],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const showUsage = process.env.RAPPTOR_USAGE_PUBLIC_PAGE?.toLowerCase() === 'on';
  const showExperimental = experimentalTssPublicEnabled();
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <PortalHeader showUsage={showUsage} />
        {children}
        <footer className="portal-footer">
          <div className="portal-shell">
            <div><strong>RAPPTOR</strong><p>Bacterial promoter predictions and genome-resolved evidence.</p></div>
            <nav aria-label="Footer navigation"><Link href="/genomes">Genomes</Link><Link href="/cyanobacteria">Cyanobacteria</Link>{showExperimental ? <Link href="/experimental-tss">Experimental TSS</Link> : null}{showUsage && <Link href="/usage">Usage</Link>}</nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
