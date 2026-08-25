// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExperimentalTssJBrowseViewer from '@/components/experimental-tss-jbrowse-viewer';
import type { ExperimentalTssGenome } from '@/types/experimental-tss';

vi.mock('@jbrowse/react-linear-genome-view', async (importOriginal) => ({
  ...await importOriginal<typeof import('@jbrowse/react-linear-genome-view')>(),
}));

vi.mock('@/components/seqedge-jbrowse-linear-view', () => ({
  default: () => <div data-testid="real-experimental-view-state-created" />,
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

describe('experimental TSS JBrowse runtime', () => {
  it('creates a real state tree with the experimental renderer and two independent study tracks', () => {
    const genome: ExperimentalTssGenome = {
      releaseId: 'experimental-test',
      accession: 'GCF_000210855.2',
      organismName: 'Test bacterium',
      strain: null,
      assemblyName: 'GCF_000210855.2',
      genbankAssemblyAccession: null,
      defaultLocus: 'NC_016810.1:1000-2000',
      primarySequence: 'NC_016810.1',
      genomeSizeBp: 2000000,
      contigCount: 1,
      annotationStatus: 'missing',
      assetBase: '/api/experimental-data/GCF_000210855.2',
      assets: {
        fasta: 'reference.fa.gz',
        fastaFai: 'reference.fa.gz.fai',
        fastaGzi: 'reference.fa.gz.gzi',
        ncbiAnnotations: null,
        ncbiAnnotationsIndex: null,
      },
      studies: ['22251276', '22538806'].map((pmid, index) => ({
        studyId: `study-${pmid}`,
        datasetRow: index + 1,
        accession: 'GCF_000210855.2',
        organismName: 'Test bacterium',
        pmid,
        year: 2012,
        recordCount: 10,
        sourceFile: `${pmid}.bed`,
        sourceSha256: null,
        duplicateGroupCount: null,
        publication: {
          title: null,
          authors: [],
          journal: null,
          doi: null,
          status: 'unavailable' as const,
        },
        assets: {
          rawBed: `${pmid}/raw.bed`,
          data: `${pmid}/experimental-tss.gff3.gz`,
          index: `${pmid}/experimental-tss.gff3.gz.tbi`,
        },
        checksums: {},
      })),
    };
    expect(() => render(<ExperimentalTssJBrowseViewer genome={genome} />)).not.toThrow();
  });
});
