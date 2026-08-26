// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import UnifiedJBrowseViewer from '@/features/genome-browser/components/unified-jbrowse-viewer';
import { makeGenome } from '../fixtures/release';
import type { ExperimentalTssGenome } from '@/types/experimental-tss';

vi.mock('@jbrowse/react-linear-genome-view', async (importOriginal) => ({
  ...await importOriginal<typeof import('@jbrowse/react-linear-genome-view')>(),
}));

vi.mock('@/features/genome-browser/components/rapptor-jbrowse-linear-view', () => ({
  default: () => <div data-testid="real-unified-view-state-created" />,
}));

beforeAll(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterAll(() => vi.unstubAllGlobals());

describe('unified JBrowse runtime', () => {
  it('creates one real state tree containing prediction and experimental plugins', () => {
    const accession = 'GCF_000210855.2';
    const releaseGenome = makeGenome({ accession });
    releaseGenome.assets.promoterScoresPlus = `${accession}/scores.plus.bw`;
    releaseGenome.assets.promoterScoresMinus = `${accession}/scores.minus.bw`;
    const prediction = {
      assemblyName: accession,
      defaultLocus: 'NC_016810.1:1-10000',
      assetBase: '/api/remote-data',
      assets: releaseGenome.assets,
    };
    const experimental: ExperimentalTssGenome = {
      releaseId: 'experimental-test',
      accession,
      organismName: 'Test bacterium',
      strain: null,
      assemblyName: accession,
      genbankAssemblyAccession: null,
      defaultLocus: 'NC_016810.1:1000-2000',
      primarySequence: 'NC_016810.1',
      genomeSizeBp: 2000000,
      contigCount: 1,
      annotationStatus: 'missing',
      assetBase: `/api/experimental-data/${accession}`,
      assets: {
        fasta: 'reference.fa.gz',
        fastaFai: 'reference.fa.gz.fai',
        fastaGzi: 'reference.fa.gz.gzi',
        ncbiAnnotations: null,
        ncbiAnnotationsIndex: null,
      },
      studies: [{
        studyId: 'study-22251276',
        datasetRow: 1,
        accession,
        organismName: 'Test bacterium',
        pmid: '22251276',
        year: 2012,
        recordCount: 10,
        sourceFile: '22251276.bed',
        sourceSha256: null,
        duplicateGroupCount: null,
        publication: { title: null, authors: [], journal: null, doi: null, status: 'unavailable' },
        assets: {
          rawBed: '22251276/raw.bed',
          data: '22251276/experimental-tss.gff3.gz',
          index: '22251276/experimental-tss.gff3.gz.tbi',
        },
        checksums: {},
      }],
    };

    expect(() => render(<UnifiedJBrowseViewer prediction={prediction} experimental={experimental} />)).not.toThrow();
  });
});
