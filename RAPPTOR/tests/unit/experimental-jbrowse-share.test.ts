import { describe, expect, it } from 'vitest';
import {
  buildExperimentalJBrowseShareUrl,
  extractExperimentalJBrowseShareState,
  parseExperimentalJBrowseShareParams,
  type ExperimentalJBrowseShareStateV1,
} from '@/features/genome-browser/experimental-jbrowse-share';

const allowed = new Set(['study-22251276', 'study-22538806']);

describe('experimental JBrowse share codec', () => {
  it('round trips dynamic study tracks, order, height, position, zoom and orientation', () => {
    const state: ExperimentalJBrowseShareStateV1 = {
      version: 1,
      refName: 'NC_016810.1',
      center: 123456,
      bpPerPx: 0.25,
      reversed: true,
      tracks: [
        { token: 'study:study-22538806', height: 220 },
        { token: 'sequence', height: 120 },
        { token: 'study:study-22251276', height: 170 },
      ],
    };
    const url = new URL(buildExperimentalJBrowseShareUrl(
      { origin: 'https://rapptor.example', pathname: '/experimental-tss/genomes/GCF_000210855.2' } as Location,
      state,
      allowed,
    ));
    expect(url.searchParams.get('tracks')).toBe(
      'study.study-22538806:220,sequence:120,study.study-22251276:170',
    );
    expect(parseExperimentalJBrowseShareParams(url.searchParams, allowed)).toEqual({
      kind: 'valid',
      state,
      warnings: [],
    });
  });

  it('allows an empty visible-track layout and clears unrelated query and hash state', () => {
    const url = new URL(buildExperimentalJBrowseShareUrl(
      { origin: 'https://rapptor.example/private?token=secret', pathname: '/experimental-tss/genomes/GCF_1?asset=blob:private#x' } as Location,
      {
        version: 1,
        refName: 'contig 1',
        center: 1,
        bpPerPx: 2,
        reversed: false,
        tracks: [],
      },
      allowed,
    ));
    expect(url.pathname).toBe('/experimental-tss/genomes/GCF_1%3Fasset=blob:private%23x');
    expect([...url.searchParams.keys()]).toEqual(['view', 'ref', 'center', 'zoom', 'rev', 'tracks']);
    expect(url.searchParams.get('tracks')).toBe('');
    expect(parseExperimentalJBrowseShareParams(url.searchParams, allowed).kind).toBe('valid');
  });

  it('rejects unknown or injected study IDs, duplicates, and invalid heights', () => {
    for (const tracks of [
      'study.unknown:170',
      'study.https://evil.example:170',
      'study.study-22251276:170,study.study-22251276:180',
      'study.study-22251276:19',
      'study.study-22251276:1001',
    ]) {
      const parsed = parseExperimentalJBrowseShareParams(new URLSearchParams({
        view: '1', ref: 'NC_016810.1', center: '10', zoom: '1', rev: '0', tracks,
      }), allowed);
      expect(parsed.kind).toBe('invalid');
    }
  });

  it('extracts only whitelisted registered tracks in their visible order', () => {
    const view = {
      width: 1000,
      bpPerPx: 0.5,
      displayedRegions: [{ refName: 'NC_016810.1' }],
      tracks: [
        { configuration: 'track-study-b', displays: [{ height: 190 }] },
        { configuration: 'external-track', displays: [{ height: 300 }] },
        { configuration: 'reference', displays: [{ heightPreConfig: 120 }] },
      ],
      pxToBp: (px: number) => ({
        refName: 'NC_016810.1',
        coord: px === 500 ? 7654 : px === 0 ? 7404 : 7904,
        oob: false,
        reversed: true,
      }),
    };
    expect(extractExperimentalJBrowseShareState(view, {
      sequence: 'reference',
      studies: { 'study-22251276': 'track-study-a', 'study-22538806': 'track-study-b' },
    })).toEqual({
      kind: 'valid',
      state: {
        version: 1,
        refName: 'NC_016810.1',
        center: 7654,
        bpPerPx: 0.5,
        reversed: true,
        tracks: [
          { token: 'study:study-22538806', height: 190 },
          { token: 'sequence', height: 120 },
        ],
      },
      warnings: [],
    });
  });
});
