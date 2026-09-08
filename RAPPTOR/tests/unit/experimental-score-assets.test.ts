import { describe, expect, it, vi } from 'vitest';
import release from '@/generated/experimental-score-release.json';
import { experimentalScoreAssets } from '@/features/genome-browser/experimental-score-assets';
import { JsonExperimentalTssRepository } from '@/features/genome-browser/experimental-tss-repository';

vi.mock('server-only', () => ({}));

const accession = 'GCF_000005845.1';
const collectionBase = `https://huggingface.co/datasets/${release.repository}/resolve/older-reference-revision/${release.collectionPath}`;
const referencePath = `genome_sequences/${accession}.fna`;
const scores = `https://huggingface.co/datasets/${release.repository}/resolve/${release.revision}/${release.collectionPath}/${release.scorePath}/${accession}/${accession}.promoter_scores.sigma1`;

describe('published experimental genome model scores', () => {
  it('uses the verified score revision independently of the older reference revision', () => {
    expect(experimentalScoreAssets(accession, referencePath, collectionBase)).toEqual({
      promoterScoresPlus: `${scores}.plus.bw`, promoterScoresMinus: `${scores}.minus.bw`,
    });
    expect(release.accessions).toHaveLength(90);
    expect(new Set(release.accessions).size).toBe(90);
  });

  it.each([
    ['GCF_999999999.1', 'genome_sequences/GCF_999999999.1.fna', collectionBase],
    ['GCF_000005845.2', 'genome_sequences/GCF_000005845.2.fna', collectionBase],
    [accession, 'subset/reference.fa.gz', collectionBase],
    [accession, referencePath, 'https://example.test/custom-release'],
    [accession, referencePath, `${collectionBase}/other-release`],
  ])('does not attach scores to an unlisted or different reference: %s %s %s', (id, reference, base) => {
    expect(experimentalScoreAssets(id, reference, base)).toEqual({ promoterScoresPlus: null, promoterScoresMinus: null });
  });

  it('exposes both BigWigs through the repository used by collection and D1 catalogs', async () => {
    const repository = new JsonExperimentalTssRepository({
      releaseKind: 'experimental_tss', releaseId: 'old-reference-release', assetBase: collectionBase,
      studies: [], genomes: [{ accession, studies: [], referenceStorage: { files: { fasta: referencePath } } }],
    });
    expect((await repository.getGenome(accession))?.assets).toMatchObject({
      fasta: 'reference.fa', promoterScoresPlus: 'promoter-scores.plus.bw', promoterScoresMinus: 'promoter-scores.minus.bw',
    });
    expect((await repository.resolveAsset(accession, 'reference.fa'))?.upstreamUrl).toBe(`${collectionBase}/${referencePath}`);
    for (const strand of ['plus', 'minus']) {
      expect(await repository.resolveAsset(accession, `promoter-scores.${strand}.bw`)).toMatchObject({
        upstreamUrl: `${scores}.${strand}.bw`, kind: 'model-scores', contentType: 'application/x-bigwig', transform: null,
      });
    }
    expect(await repository.resolveAsset(accession, 'other/promoter-scores.plus.bw')).toBeNull();
  });
});
