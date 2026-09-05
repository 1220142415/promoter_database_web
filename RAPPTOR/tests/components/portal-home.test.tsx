// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HomePage from '@/app/page';

vi.mock('server-only', () => ({}));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('portal home', () => {
  it('renders the checked-in release snapshot without client-side API or D1 requests', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<HomePage />);

    expect(screen.getByRole('heading', { name: 'RAPPTOR' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Predict promoters from your sequence' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Predict a promoter' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open prediction tool/ })).toHaveAttribute('href', '/predict');
    expect(screen.queryByRole('link', { name: 'Read the prediction guide' })).not.toBeInTheDocument();
    expect(document.querySelector('#predict')).toBeInTheDocument();
    expect(screen.queryByText('DEMO PREVIEW')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('Catalog genomes80,850');
    expect(screen.getByLabelText('Release statistics')).not.toHaveTextContent('GTDB + collected assemblies');
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('306,900,844');
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('NCBI annotations53,285');
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('Experimental genomes90');
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('Observations440,947');
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('Source publications78');
    expect(screen.getByLabelText('Release statistics')).not.toHaveTextContent('Current release');
    expect(screen.getByLabelText('Release statistics')).not.toHaveTextContent('gtdb-r214-2026-08-13');
    expect(screen.getByText('80,850 assemblies')).toBeInTheDocument();
    expect(screen.getByText('Pseudomonadota')).toBeInTheDocument();
    expect(screen.queryByLabelText('Release downloads')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('gtdb-r214-2026-08-13');
    expect(screen.getByRole('link', { name: /Experimental TSS/ })).toHaveAttribute('href', '/experimental-tss');
    expect(screen.queryByRole('link', { name: /Cyanobacteria/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Predictions and observations stay separate')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
