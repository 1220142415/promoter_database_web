// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PredictionHelpPage from '@/app/help/prediction/page';

vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));

describe('prediction help', () => {
  it('connects the guide to the workspace and explains inputs, results and privacy', () => {
    render(<PredictionHelpPage />);

    expect(screen.getByRole('heading', { name: 'Use RAPPTOR prediction results with the right context' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open prediction workspace/ })).toHaveAttribute('href', '/predict');
    expect(screen.queryByRole('link', { name: /Return to prediction workspace/ })).not.toBeInTheDocument();
    expect(screen.getByText('Return to prediction workspace')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('navigation', { name: 'Prediction help contents' })).toHaveTextContent('Quick start');
    expect(screen.getByRole('heading', { name: 'The input determines what RAPPTOR runs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Results adapt without changing what a score means' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Exactly one 100 bp record' })).toBeInTheDocument();
    expect(screen.getByText(/skips them and reports how many were skipped/)).toBeInTheDocument();
    expect(screen.getByText('Top results').parentElement).toHaveTextContent('Shown only for Scan');
    expect(screen.getByText(/Focused GFF3\/BED6 features cover the evaluated 100 bp window/)).toBeInTheDocument();
    expect(screen.getAllByText(/50 MiB/).length).toBeGreaterThan(0);
    expect(screen.getByText(/does not submit prototype input/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Choose a workflow');
    expect(document.body).not.toHaveTextContent('Fixed threshold');
    expect(document.body).not.toHaveTextContent('Evidence boundary');
  });
});
