/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExperimentalTssPage from '@/app/experimental-tss/page';
import ExperimentalGenomePage from '@/app/experimental-tss/genomes/[accession]/page';

const permanentRedirect = vi.fn((destination: string) => { throw new Error(`redirect:${destination}`); });
vi.mock('next/navigation', () => ({ permanentRedirect: (destination: string) => permanentRedirect(destination) }));

beforeEach(() => vi.clearAllMocks());

describe('legacy experimental TSS routes', () => {
  it('moves the former collection into the unified genome evidence filter', () => {
    expect(() => ExperimentalTssPage()).toThrow('redirect:/genomes?evidence=experimental');
    expect(permanentRedirect).toHaveBeenCalledWith('/genomes?evidence=experimental');
  });

  it('redirects old genome shares and drops unknown query parameters', async () => {
    await expect(ExperimentalGenomePage({
      params: Promise.resolve({ accession: 'GCF_000210855.2' }),
      searchParams: Promise.resolve({
        view: '1', ref: 'NC_016810.1', center: '1000', zoom: '0.5', rev: '1',
        tracks: 'sequence:120,study.example:170', private: 'discard', asset: 'blob:secret',
      }),
    })).rejects.toThrow('redirect:');

    expect(permanentRedirect).toHaveBeenCalledWith(
      '/genomes/GCF_000210855.2?view=1&ref=NC_016810.1&center=1000&zoom=0.5&rev=1&tracks=sequence%3A120%2Cstudy.example%3A170',
    );
  });

  it('drops repeated share values instead of choosing one', async () => {
    await expect(ExperimentalGenomePage({
      params: Promise.resolve({ accession: 'GCF_000210855.2' }),
      searchParams: Promise.resolve({ view: ['1', '2'], ref: 'NC_016810.1', token: 'secret' }),
    })).rejects.toThrow('redirect:');
    expect(permanentRedirect).toHaveBeenCalledWith('/genomes/GCF_000210855.2?ref=NC_016810.1');
  });
});
