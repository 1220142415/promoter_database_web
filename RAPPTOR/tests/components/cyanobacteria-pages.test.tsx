// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CyanobacteriaPage from '@/app/cyanobacteria/page';
import CyanobacteriaGenomePage from '@/app/cyanobacteria/[genomeId]/page';
import continuousRelease from '@/generated/cyanobacteria-continuous-score-release.json';

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

  it('publishes the available cyanobacteria TSS study', async () => {
    const page = await CyanobacteriaGenomePage({ params: Promise.resolve({ genomeId: 'ASM970v1' }) });
    render(page);
    expect(screen.getByText('Literature evidence')).toBeInTheDocument();
    expect(screen.getAllByText('13,705')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'PMID 22135468' })).toHaveAttribute('href', 'https://pubmed.ncbi.nlm.nih.gov/22135468/');
    const config = JSON.parse(screen.getByTestId('cyanobacteria-browser-config').textContent || '{}');
    expect(config.prediction.assemblyName).toBe('ASM970v1');
    expect(config.prediction.assetBase).toMatch(/\/v-1f43a48b29419a4a95d2970931fdd787d496953a$/);
    expect(config.experimental.studies[0].studyId).toBe('2011_22135468_GCF_000009705.1');
    for (const [key, strand] of [['promoterScoresPlus', 'plus'], ['promoterScoresMinus', 'minus']]) {
      const url = `/api/cyanobacteria-data/ASM970v1/v-${continuousRelease.revision || continuousRelease.version}/promoter_scores.sigma1.${strand}.bw`;
      expect(config.prediction.assets[key]).toBe(url);
      expect(config.experimental.assets[key]).toBe(url);
    }
    expect(config.prediction.smoothScoreTrack).not.toBe(true);
    expect(config.prediction.precomputedScoreSigma).toBe(1);
    expect(config.prediction.assets.predictedPromoters).toBe('predicted-promoters.gff3.gz');
  });

  it.each(['Cf6912', 'CP003597.1'])('uses continuous scores without inventing experimental evidence for %s', async (genomeId) => {
    render(await CyanobacteriaGenomePage({ params: Promise.resolve({ genomeId }) }));
    const config = JSON.parse(screen.getByTestId('cyanobacteria-browser-config').textContent || '{}');
    const base = `/api/cyanobacteria-data/${genomeId}/v-${continuousRelease.revision || continuousRelease.version}`;
    expect(config.prediction.assets.promoterScoresPlus).toBe(`${base}/promoter_scores.sigma1.plus.bw`);
    expect(config.prediction.assets.promoterScoresMinus).toBe(`${base}/promoter_scores.sigma1.minus.bw`);
    expect(config.prediction.precomputedScoreSigma).toBe(1);
    expect(config.prediction.smoothScoreTrack).not.toBe(true);
    expect(config.experimental).toBeNull();
    expect(config.prediction.assets.predictedPromoters).toBe('predicted-promoters.gff3.gz');
  });
});
