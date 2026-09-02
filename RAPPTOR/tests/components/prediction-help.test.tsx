// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PredictionHelpPage from '@/app/help/prediction/page';

vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));

describe('prediction help', () => {
  it('explains the unified input card, two examples, focused results and browser scans', () => {
    render(<PredictionHelpPage />);

    expect(screen.getByRole('heading', { name: 'Understand RAPPTOR prediction results' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open prediction/ })).toHaveAttribute('href', '/predict');
    expect(screen.getByRole('navigation', { name: 'Prediction help contents' })).toHaveTextContent('Quick start');
    expect(screen.getByRole('heading', { name: 'Use one input card' })).toBeInTheDocument();
    expect(screen.getByText(/Paste text and select a file in the same card/)).toBeInTheDocument();
    expect(screen.getByText(/Every Focused or Scan input needs the complete matching genome/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '100 bp sequence' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'E. coli K-12 genome' })).toBeInTheDocument();
    expect(screen.getByText('GCF_000005845.2')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The input determines the analysis' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Focused and scan results are different' })).toBeInTheDocument();
    expect(screen.getByText('Step').parentElement).toHaveTextContent('1, 5, 10 or 20 nt');
    expect(screen.getByRole('heading', { name: 'Know what the prediction service is doing' })).toBeInTheDocument();
    expect(screen.getByText(/percentage describes job processing only/)).toHaveTextContent('not a promoter score, accuracy, confidence');
    expect(screen.getByText(/briefly simulates these stages/)).toHaveTextContent('No model or real queue is used');
    expect(screen.getByRole('heading', { name: 'Exactly one 100 bp record' })).toBeInTheDocument();
    expect(screen.getByText(/skips them and reports how many were skipped/)).toBeInTheDocument();
    expect(screen.queryByText('Top results')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Read a scan in JBrowse 2' })).toBeInTheDocument();
    expect(screen.getByText('Reference sequence')).toBeInTheDocument();
    expect(screen.getByText('Raw score')).toBeInTheDocument();
    expect(screen.getByText('Called peak')).toBeInTheDocument();
    expect(screen.getByText(/Both analyses provide only the two track formats/)).toBeInTheDocument();
    expect(screen.getByText('bedGraph').parentElement).toHaveTextContent('raw scores');
    expect(screen.getByText('GFF3').parentElement).toHaveTextContent('Focused windows or 1 bp Scan peaks');
    expect(screen.getAllByText(/50 MiB/).length).toBeGreaterThan(0);
    expect(screen.getByText(/not written to/)).toHaveTextContent('/api/predictions');
    expect(screen.getByText(/If you reload, open a copied link/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('workflow');
    expect(document.body).not.toHaveTextContent('workspace');
    expect(document.body).not.toHaveTextContent('Fixed threshold');
    expect(document.body).not.toHaveTextContent('Evidence boundary');
  });
});
