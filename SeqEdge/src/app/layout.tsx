import type { Metadata } from 'next';
import Link from 'next/link';
import PortalHeader from '@/components/portal-header';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SeqEdge | Bacterial promoter resource', template: '%s' },
  description: 'Genome-resolved bacterial promoter predictions, reference assemblies and contextual NCBI annotations.',
  keywords: ['bacterial promoters', 'RAPPtor', 'GTDB taxonomy', 'genome browser', 'JBrowse 2'],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <PortalHeader />
        {children}
        <footer className="portal-footer">
          <div className="portal-shell">
            <div><strong>SeqEdge</strong><p>Bacterial promoter predictions and genome-resolved evidence.</p></div>
            <nav aria-label="Footer navigation"><Link href="/genomes">Genomes</Link><Link href="/#data">Release files</Link></nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
