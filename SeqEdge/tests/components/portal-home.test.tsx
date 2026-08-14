// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HomePage from '@/app/page';

vi.mock('server-only', () => ({}));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));

describe('portal home', () => {
  it('renders the checked-in release snapshot without client-side API or D1 requests', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<HomePage />);

    expect(screen.getByRole('heading', { name: 'SeqEdge' })).toBeInTheDocument();
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('80,789');
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('1,888,109,477');
    expect(screen.getByLabelText('Release statistics')).toHaveTextContent('NCBI annotations cataloged53,285');
    expect(screen.getByText('80,789 assemblies')).toBeInTheDocument();
    expect(screen.getByText('Pseudomonadota')).toBeInTheDocument();
    expect(screen.queryByLabelText('Release downloads')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
