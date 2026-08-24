import { describe, expect, it } from 'vitest';

import { plannedHfBatchAssets } from '@/lib/hf-batch-assets';

const summary = JSON.stringify({
  assetLayout: {
    layout: 'promoter-batch-v1',
    baseUrl: 'https://huggingface.co/datasets/owner/repository/resolve/main',
    fileTemplates: {
      reference: '{batch}/genomes/{accession}_genomic.fna.gz',
      predictedPromoters: '{batch}/promoter_gff/{accession}.promoters_up80_down20_gt_0.9.gff3',
      promoterScoresPlus: '{batch}/promoter_bw/{accession}/promoter-scores.plus.bw',
      promoterScoresMinus: '{batch}/promoter_bw/{accession}/promoter-scores.minus.bw',
      ncbiAnnotations: '{batch}/ncbi_gff3/{accession}.genomic.gff3.gz',
    },
    promoterScoreBatches: ['000'],
    batches: [
      { id: '000', firstAccession: 'GCA_000000001.1', lastAccession: 'GCA_000000002.1' },
      { id: '080', firstAccession: 'GCF_900000001.1', lastAccession: 'GCF_999999999.1' },
    ],
  },
});

describe('planned Hugging Face batch assets', () => {
  it('maps first and future batches without per-genome database paths', () => {
    expect(plannedHfBatchAssets(summary, 'GCA_000000002.1', true, {
      reference: 'a'.repeat(64),
      predictedPromoters: 'b'.repeat(64),
      promoterScoresPlus: 'd'.repeat(64),
      promoterScoresMinus: 'e'.repeat(64),
      ncbiAnnotations: 'c'.repeat(64),
    })).toEqual({
      batch: '000',
      reference: 'https://huggingface.co/datasets/owner/repository/resolve/main/000/genomes/GCA_000000002.1_genomic.fna.gz',
      predictedPromoters: 'https://huggingface.co/datasets/owner/repository/resolve/main/000/promoter_gff/GCA_000000002.1.promoters_up80_down20_gt_0.9.gff3',
      promoterScoresPlus: 'https://huggingface.co/datasets/owner/repository/resolve/main/000/promoter_bw/GCA_000000002.1/promoter-scores.plus.bw',
      promoterScoresMinus: 'https://huggingface.co/datasets/owner/repository/resolve/main/000/promoter_bw/GCA_000000002.1/promoter-scores.minus.bw',
      ncbiAnnotations: 'https://huggingface.co/datasets/owner/repository/resolve/main/000/ncbi_gff3/GCA_000000002.1.genomic.gff3.gz',
      cacheVersions: {
        reference: 'a'.repeat(64),
        predictedPromoters: 'b'.repeat(64),
        promoterScoresPlus: 'd'.repeat(64),
        promoterScoresMinus: 'e'.repeat(64),
        ncbiAnnotations: 'c'.repeat(64),
      },
    });
    expect(plannedHfBatchAssets(summary, 'GCF_945605565.1', false)).toMatchObject({
      batch: '080',
      promoterScoresPlus: null,
      promoterScoresMinus: null,
      ncbiAnnotations: null,
      cacheVersions: {
        reference: null,
        predictedPromoters: null,
        promoterScoresPlus: null,
        promoterScoresMinus: null,
        ncbiAnnotations: null,
      },
    });
  });

  it('keeps legacy layouts working without score tracks', () => {
    const legacy = JSON.stringify({
      assetLayout: {
        ...JSON.parse(summary).assetLayout,
        promoterScoreBatches: undefined,
        fileTemplates: {
          reference: '{batch}/genomes/{accession}_genomic.fna.gz',
          predictedPromoters: '{batch}/promoter_gff/{accession}.promoters_up80_down20_gt_0.9.gff3',
          ncbiAnnotations: '{batch}/ncbi_gff3/{accession}.genomic.gff3.gz',
        },
      },
    });

    expect(plannedHfBatchAssets(legacy, 'GCA_000000001.1', false)).toMatchObject({
      promoterScoresPlus: null,
      promoterScoresMinus: null,
      cacheVersions: { promoterScoresPlus: null, promoterScoresMinus: null },
    });
  });

  it('drops the score pair when either template or the batch declaration is unsafe', () => {
    const singleTemplate = JSON.parse(summary);
    delete singleTemplate.assetLayout.fileTemplates.promoterScoresMinus;
    const unknownBatch = JSON.parse(summary);
    unknownBatch.assetLayout.promoterScoreBatches = ['001'];

    expect(plannedHfBatchAssets(singleTemplate, 'GCA_000000001.1', false)).toMatchObject({
      promoterScoresPlus: null,
      promoterScoresMinus: null,
    });
    expect(plannedHfBatchAssets(unknownBatch, 'GCA_000000001.1', false)).toMatchObject({
      promoterScoresPlus: null,
      promoterScoresMinus: null,
    });
  });

  it('maps the uploaded GCA_000381585.1 score pair with the production layout', () => {
    const productionSummary = {
      assetLayout: {
        layout: 'promoter-batch-v1',
        baseUrl: 'https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes/resolve/main',
        fileTemplates: {
          reference: '{batch}/genomes/{accession}_genomic.fna.gz',
          predictedPromoters: '{batch}/promoter_gff/{accession}.promoters_up80_down20_gt_0.9.gff3',
          promoterScoresPlus: '{batch}/promoter_bw/{accession}/promoter-scores.plus.bw',
          promoterScoresMinus: '{batch}/promoter_bw/{accession}/promoter-scores.minus.bw',
          ncbiAnnotations: '{batch}/ncbi_gff3/{accession}.genomic.gff3.gz',
        },
        promoterScoreBatches: ['000'],
        batches: [{ id: '000', firstAccession: 'GCA_000381585.1', lastAccession: 'GCA_000381585.1' }],
      },
    };

    expect(plannedHfBatchAssets(productionSummary, 'GCA_000381585.1', false)).toMatchObject({
      promoterScoresPlus: 'https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes/resolve/main/000/promoter_bw/GCA_000381585.1/promoter-scores.plus.bw',
      promoterScoresMinus: 'https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes/resolve/main/000/promoter_bw/GCA_000381585.1/promoter-scores.minus.bw',
    });
  });

  it('rejects unknown accessions and unsafe storage configuration', () => {
    expect(plannedHfBatchAssets(summary, 'GCA_999999999.1', true)).toBeNull();
    expect(plannedHfBatchAssets(summary.replace('https://huggingface.co', 'javascript://huggingface.co'), 'GCA_000000001.1', true)).toBeNull();
  });

  it('ignores malformed cache versions instead of trusting unverified metadata', () => {
    expect(plannedHfBatchAssets(summary, 'GCA_000000001.1', true, {
      reference: 'sha256:' + 'a'.repeat(64),
      predictedPromoters: 'ABC',
      ncbiAnnotations: 'c'.repeat(63),
    })?.cacheVersions).toEqual({
      reference: null,
      predictedPromoters: null,
      promoterScoresPlus: null,
      promoterScoresMinus: null,
      ncbiAnnotations: null,
    });
  });
});
