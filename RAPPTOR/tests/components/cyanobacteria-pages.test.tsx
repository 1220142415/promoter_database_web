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

  it('adds the published cyanobacteria TSS study to the public browser config', async () => {
    const page = await CyanobacteriaGenomePage({ params: Promise.resolve({ genomeId: 'ASM970v1' }) });
    render(page);
    expect(screen.getByText('Literature evidence')).toBeInTheDocument();
    expect(screen.getByText('13,705', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PMID 22135468' })).toHaveAttribute('href', 'https://pubmed.ncbi.nlm.nih.gov/22135468/');
    const config = JSON.parse(screen.getByTestId('cyanobacteria-browser-config').textContent || '{}');
    expect(config.prediction.assemblyName).toBe('ASM970v1');
    expect(config.experimental).toMatchObject({
      accession: 'ASM970v1',
      assemblyName: 'ASM970v1',
      studies: [{ pmid: '22135468', year: 2011, recordCount: 13705 }],
    });
  });
});
