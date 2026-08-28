// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CyanobacteriaPage from '@/app/cyanobacteria/page';
import CyanobacteriaGenomePage from '@/app/cyanobacteria/[genomeId]/page';

vi.mock('next/navigation', () => ({ notFound: vi.fn(() => { throw new Error('not found'); }) }));
vi.mock('@/features/genome-browser/components/portal-browser-panel', () => ({
  default: ({ assembly }: { assembly: Record<string, unknown> }) => (
    <pre data-testid="cyanobacteria-browser-config">{JSON.stringify(assembly)}</pre>
  ),
}));

describe('cyanobacteria collection pages', () => {
  it('shows all three final-prediction genome cards without candidate-peak presentation', () => {
    render(<CyanobacteriaPage />);
    expect(screen.getByRole('heading', { name: 'Cyanobacterial promoter predictions' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Open genome browser/ })).toHaveLength(3);
    expect(screen.getByText('40,789')).toBeInTheDocument();
    expect(screen.getByText('36,353')).toBeInTheDocument();
    expect(screen.getByText('35,720')).toBeInTheDocument();
    expect(screen.getAllByText('NCBI genome annotation')).toHaveLength(2);
    expect(screen.getByText('Prodigal CDS prediction')).toBeInTheDocument();
    expect(screen.queryByText(/candidate peak/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Independent research collection')).not.toBeInTheDocument();
    expect(screen.queryByText('Evidence boundary')).not.toBeInTheDocument();
    expect(screen.queryByText(/RAPPTOR peaks in this collection/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fixed model score/i)).not.toBeInTheDocument();
    expect(screen.getByText('Final promoter predictions use the model score > 0.9 rule.')).toBeInTheDocument();
  });

  it('configures the Cf6912 browser with raw score, final prediction and honest Prodigal tracks', async () => {
    const page = await CyanobacteriaGenomePage({ params: Promise.resolve({ genomeId: 'Cf6912' }) });
    render(page);
    expect(screen.getByRole('heading', { name: 'Chlorogloeopsis fritschii PCC 6912' })).toBeInTheDocument();
    expect(screen.getAllByText('Prodigal CDS prediction')).toHaveLength(2);
    expect(screen.getByText(/does not provide functional product annotation/i)).toBeInTheDocument();
    expect(screen.queryByText('Candidate scores and final calls')).not.toBeInTheDocument();
    expect(screen.queryByText('Candidate peaks source')).not.toBeInTheDocument();
    expect(screen.queryByText('Genome metadata')).not.toBeInTheDocument();
    expect(screen.queryByText('Evidence boundary')).not.toBeInTheDocument();
    expect(screen.queryByText(/candidate peak/i)).not.toBeInTheDocument();
    expect(screen.getByText('Final promoter predictions')).toBeInTheDocument();
    const config = JSON.parse(screen.getByTestId('cyanobacteria-browser-config').textContent || '{}');
    expect(config.assemblyName).toBe('Cf6912');
    expect(config.annotationTrackKind).toBe('annotation');
    expect(config.trackLabels).toEqual({
      scores: 'Raw prediction scores (+ / - strands)',
      promoters: 'Predicted promoters (score > 0.9)',
      annotation: 'Prodigal CDS prediction',
    });
    expect(config.assets).toMatchObject({
      fasta: 'reference.fa.gz',
      promoterScoresPlus: 'candidate-peak-scores.plus.bw',
      promoterScoresMinus: 'candidate-peak-scores.minus.bw',
      predictedPromoters: 'predicted-promoters.gff3.gz',
      ncbiAnnotations: 'genome-annotations.gff3.gz',
    });
    expect(config.assets.experimentalTss).toBeNull();
    expect(screen.queryByText(/Literature evidence/i)).not.toBeInTheDocument();
  });

  it('adds only the assembly-matched ASM970v1 study as a separate experimental TSS track', async () => {
    const page = await CyanobacteriaGenomePage({ params: Promise.resolve({ genomeId: 'ASM970v1' }) });
    render(page);

    expect(screen.getByText('Literature evidence')).toBeInTheDocument();
    expect(screen.getAllByText('Experimentally supported TSS (Mitschke et al., 2011)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('13,705')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'PMID 22135468' })).toHaveAttribute(
      'href',
      'https://pubmed.ncbi.nlm.nih.gov/22135468/',
    );
    expect(screen.queryByText('Original experimental TSS study BED')).not.toBeInTheDocument();

    const config = JSON.parse(screen.getByTestId('cyanobacteria-browser-config').textContent || '{}');
    expect(config.trackLabels.experimentalTss).toBe('Experimentally supported TSS (Mitschke et al., 2011)');
    expect(config.assets).toMatchObject({
      experimentalTss: 'experimentally-supported-tss.gff3.gz',
      experimentalTssIndex: 'experimentally-supported-tss.gff3.gz.tbi',
      experimentalTssSource: 'sources/experimentally-supported-tss.source.bed.gz',
    });
  });
});
