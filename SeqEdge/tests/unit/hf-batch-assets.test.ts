import { describe, expect, it } from 'vitest';

import { plannedHfBatchAssets } from '@/lib/hf-batch-assets';

const summary = JSON.stringify({
  assetLayout: {
    layout: 'promoter-batch-v1',
    baseUrl: 'https://huggingface.co/datasets/owner/repository/resolve/main',
    fileTemplates: {
      reference: '{batch}/genomes/{accession}_genomic.fna.gz',
      predictedPromoters: '{batch}/promoter_gff/{accession}.promoters_up80_down20_gt_0.9.gff3',
      ncbiAnnotations: '{batch}/ncbi_gff3/{accession}.genomic.gff3.gz',
    },
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
      ncbiAnnotations: 'c'.repeat(64),
    })).toEqual({
      batch: '000',
      reference: 'https://huggingface.co/datasets/owner/repository/resolve/main/000/genomes/GCA_000000002.1_genomic.fna.gz',
      predictedPromoters: 'https://huggingface.co/datasets/owner/repository/resolve/main/000/promoter_gff/GCA_000000002.1.promoters_up80_down20_gt_0.9.gff3',
      ncbiAnnotations: 'https://huggingface.co/datasets/owner/repository/resolve/main/000/ncbi_gff3/GCA_000000002.1.genomic.gff3.gz',
      cacheVersions: {
        reference: 'a'.repeat(64),
        predictedPromoters: 'b'.repeat(64),
        ncbiAnnotations: 'c'.repeat(64),
      },
    });
    expect(plannedHfBatchAssets(summary, 'GCF_945605565.1', false)).toMatchObject({
      batch: '080',
      ncbiAnnotations: null,
      cacheVersions: { reference: null, predictedPromoters: null, ncbiAnnotations: null },
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
      ncbiAnnotations: null,
    });
  });
});
