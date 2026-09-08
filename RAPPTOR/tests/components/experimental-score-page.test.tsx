// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExperimentalTssGenome } from '@/types/experimental-tss';
import type { JBrowseReleaseAssembly } from '@/types/release';

vi.mock('server-only', () => ({}));
vi.mock('@/features/genome-browser/unified-genome-repository', () => ({ unifiedGenomeRepository: { getByAccession: vi.fn() } }));
vi.mock('@/features/genome-browser/components/unified-browser-panel', () => ({
  default: ({ prediction, experimental }: { prediction: JBrowseReleaseAssembly; experimental: ExperimentalTssGenome | null }) => (
    <div data-testid="browser-contract" data-plus={prediction.assets.promoterScoresPlus} data-minus={prediction.assets.promoterScoresMinus} data-experimental={experimental?.accession} />
  ),
}));
import GenomeDetailPage from '@/app/genomes/[accession]/page';
import { unifiedGenomeRepository } from '@/features/genome-browser/unified-genome-repository';
import { JsonExperimentalTssRepository } from '@/features/genome-browser/experimental-tss-repository';

afterEach(() => vi.unstubAllEnvs());

it('passes collection scores and experimental evidence to the browser even without a primary contig in metadata', async () => {
  vi.stubEnv('RAPPTOR_EXPERIMENTAL_TSS_PUBLIC_PAGE', 'on');
  const accession = 'GCF_000005845.1';
  const repository = new JsonExperimentalTssRepository({
    releaseKind: 'experimental_tss', releaseId: 'collection',
    assetBase: 'https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes/resolve/main/experimentally_supported_genomes',
    studies: [], genomes: [{ accession, studies: [], referenceStorage: { files: { fasta: `genome_sequences/${accession}.fna` } } }],
  });
  vi.mocked(unifiedGenomeRepository.getByAccession).mockResolvedValue({
    canonicalAccession: accession, assemblyCompatibility: 'single_source', aliases: [],
    prediction: null, experimental: await repository.getGenome(accession),
    predictionAvailable: false, evidenceState: 'experimental_only',
    releases: { predictionReleaseId: 'prediction', experimentalReleaseId: 'collection', compositeRevision: 'both' },
  });
  render(await GenomeDetailPage({ params: Promise.resolve({ accession }) }));
  expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-plus', 'promoter-scores.plus.bw');
  expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-minus', 'promoter-scores.minus.bw');
  expect(screen.getByTestId('browser-contract')).toHaveAttribute('data-experimental', accession);
  expect(screen.getByLabelText('Genome files')).toHaveTextContent('Model scoresAvailable');
});
