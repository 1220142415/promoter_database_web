// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import PortalJBrowseViewer from '@/components/portal-jbrowse-viewer';
import { makeGenome } from '../fixtures/release';

vi.mock('@jbrowse/react-linear-genome-view', async (importOriginal) => ({
  ...await importOriginal<typeof import('@jbrowse/react-linear-genome-view')>(),
  JBrowseLinearGenomeView: () => <div data-testid="real-view-state-created" />,
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

describe('release JBrowse runtime', () => {
  it('creates the real JBrowse view state with strand renderers installed', () => {
    const accession = 'GCA_000411415.1';
    const genome = makeGenome({ accession });
    genome.assets.ncbiAnnotations = `${accession}/ncbi-annotations.gff3.gz`;
    genome.assets.ncbiAnnotationsIndex = `${accession}/ncbi-annotations.gff3.gz.tbi`;
    const assembly = {
      assemblyName: accession,
      defaultLocus: `${accession}:1-10000`,
      assetBase: '/api/local-data',
      assets: genome.assets,
    };

    expect(() => render(<PortalJBrowseViewer assembly={assembly} />)).not.toThrow();
  });
});
