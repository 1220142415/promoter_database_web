// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CyanobacteriaPage from '@/app/cyanobacteria/page';
import CyanobacteriaGenomePage from '@/app/cyanobacteria/[genomeId]/page';

vi.mock('next/navigation', () => ({ notFound: vi.fn(() => { throw new Error('not found'); }) }));
vi.mock('@/features/genome-browser/components/unified-browser-panel', () => ({
  default: ({ prediction, experimental }: { prediction: Record<string, unknown>; experimental: unknown }) => (
    <pre data-testid="cyanobacteria-browser-config">{JSON.stringify({ prediction, experimental })}</pre>
  ),
}));

describe('cyanobacteria collection pages', () => {
  it('lists the three release genomes', () => {
    render(<CyanobacteriaPage />);
    expect(screen.getByRole('heading', { name: 'Cyanobacterial promoter predictions' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Open genome browser/ })).toHaveLength(3);
    expect(screen.getByText('40,789')).toBeInTheDocument();
    expect(screen.getByText('36,353')).toBeInTheDocument();
    expect(screen.getByText('35,720')).toBeInTheDocument();
  });

  it('uses 100 bp promoter windows and publishes the available cyanobacteria TSS study', async () => {
    const page = await CyanobacteriaGenomePage({ params: Promise.resolve({ genomeId: 'ASM970v1' }) });
    render(page);
    expect(screen.getByText('Literature evidence')).toBeInTheDocument();
    expect(screen.getAllByText('13,705')).toHaveLength(3);
    const config = JSON.parse(screen.getByTestId('cyanobacteria-browser-config').textContent || '{}');
    expect(config.prediction.assemblyName).toBe('ASM970v1');
    expect(config.prediction.promoterPeakWindowBp).toBe(100);
    expect(config.experimental.studies[0].studyId).toBe('2011_22135468_GCF_000009705.1');
  });
});
