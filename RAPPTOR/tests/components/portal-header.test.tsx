// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PortalHeader from '@/components/portal-header';

vi.mock('next/navigation', () => ({ usePathname: () => '/genomes' }));
vi.mock('next/link', () => ({
  default: ({ href, children, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={String(href)}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </a>
  ),
}));

describe('portal header', () => {
  it('opens and closes the mobile navigation with an accessible toggle', async () => {
    const user = userEvent.setup();
    render(<PortalHeader showUsage />);

    const open = screen.getByRole('button', { name: 'Open navigation' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('link', { name: 'Genomes' })).toHaveClass('is-active');
    expect(screen.getByRole('link', { name: 'Predict' })).toHaveAttribute('href', '/predict');
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help/prediction');
    expect(screen.queryByRole('link', { name: 'Experimental TSS' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/usage');
    expect(screen.queryByRole('link', { name: 'Data & downloads' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cyanobacteria' })).toHaveAttribute('href', '/cyanobacteria');

    await user.click(open);
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toHaveClass('is-open');

    await user.click(screen.getByRole('link', { name: 'Overview' }));
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('hides usage when the public report is switched off', () => {
    render(<PortalHeader />);
    expect(screen.queryByRole('link', { name: 'Usage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Experimental TSS' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Run RAPPTOR' })).not.toBeInTheDocument();
  });

  it('keeps a single prediction link when the live service is enabled', () => {
    render(<PortalHeader showPrediction />);
    expect(screen.getAllByRole('link', { name: 'Predict' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Run RAPPTOR' })).not.toBeInTheDocument();
  });
});
