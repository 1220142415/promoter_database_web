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

  it('keeps unpublished cyanobacteria evidence out of the public browser config', async () => {
    const page = await CyanobacteriaGenomePage({ params: Promise.resolve({ genomeId: 'ASM970v1' }) });
    render(page);
    expect(screen.queryByText('Literature evidence')).not.toBeInTheDocument();
    const config = JSON.parse(screen.getByTestId('cyanobacteria-browser-config').textContent || '{}');
    expect(config.prediction.assemblyName).toBe('ASM970v1');
    expect(config.experimental).toBeNull();
  });
});
