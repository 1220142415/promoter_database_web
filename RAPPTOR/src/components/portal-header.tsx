'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import MenuRoundedIcon from '@mui/icons-material/MenuRounded';

const links = [
  { href: '/', label: 'Overview' },
  { href: '/genomes', label: 'Genomes' },
  { href: '/cyanobacteria', label: 'Cyanobacteria' },
  { href: '/predict', label: 'Predict' },
];

export default function PortalHeader({ showUsage = false }: { showUsage?: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const visibleLinks = [
    ...links,
    ...(showUsage ? [{ href: '/usage', label: 'Usage' }] : []),
  ];

  return (
    <header className="portal-header">
      <div className="portal-shell portal-nav-shell">
        <Link href="/" className="portal-brand" onClick={() => setOpen(false)}>
          <span className="portal-brand-mark" aria-hidden="true"><span /></span>
          <span>RAPPTOR</span>
        </Link>
        <nav className={open ? 'portal-nav is-open' : 'portal-nav'} aria-label="Primary navigation">
          {visibleLinks.map((link) => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return <Link key={link.href} href={link.href} className={active ? 'is-active' : ''} onClick={() => setOpen(false)}>{link.label}</Link>;
          })}
        </nav>
        <button
          type="button"
          className="portal-menu-button"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          aria-expanded={open}
          title={open ? 'Close navigation' : 'Open navigation'}
        >
          {open ? <CloseRoundedIcon fontSize="small" /> : <MenuRoundedIcon fontSize="small" />}
        </button>
      </div>
    </header>
  );
}
