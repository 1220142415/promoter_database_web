import { describe, expect, it } from 'vitest';
import {
  buildJBrowseShareUrl,
  extractJBrowseShareState,
  parseJBrowseShareParams,
  type JBrowseShareStateV1,
  type JBrowseShareViewLike,
  type ShareTrackRegistry,
} from '@/lib/jbrowse-share';

const registry: ShareTrackRegistry = {
  sequence: 'GCA_000411415.1-reference-sequence',
  scores: 'GCA_000411415.1-promoter-scores',
  promoters: 'GCA_000411415.1-predicted-promoters',
  annotation: 'GCA_000411415.1-ncbi-annotations',
};

const state: JBrowseShareStateV1 = {
  version: 1,
  refName: 'CP003597.1',
  center: 123456,
  bpPerPx: 0.25,
  reversed: false,
  tracks: [
    { token: 'sequence', height: 120 },
    { token: 'scores', height: 180 },
    { token: 'promoters', height: 170 },
    { token: 'annotation', height: 170 },
  ],
};

function params(value: string) {
  return new URLSearchParams(value);
}

function view(overrides: Partial<JBrowseShareViewLike> = {}): JBrowseShareViewLike {
  return {
    width: 1000,
    bpPerPx: 0.25,
    displayedRegions: [{ refName: 'CP003597.1' }],
    tracks: [
      {
        configuration: { trackId: registry.sequence },
        displays: [{ height: 122, heightPreConfig: 120 }],
      },
      {
        configuration: registry.promoters,
        displays: [{ heightPreConfig: 171 }],
      },
      {
        configuration: { trackId: 'user-added-remote-track' },
        displays: [{ height: 500 }],
      },
    ],
    pxToBp: (px) => ({
      refName: 'CP003597.1',
      coord: Math.round(199875 + px * 0.25),
      oob: false,
      reversed: true,
    }),
    ...overrides,
  };
}

describe('JBrowse share URL codec', () => {
  it('round-trips a versioned view with exact track ordering and heights', () => {
    const url = buildJBrowseShareUrl(
      { origin: 'https://rapptor.example', pathname: '/genomes/GCA_000411415.1' },
      state,
    );

    expect(url).toBe(
      'https://rapptor.example/genomes/GCA_000411415.1?view=1&ref=CP003597.1&center=123456&zoom=0.25&rev=0&tracks=sequence%3A120%2Cscores%3A180%2Cpromoters%3A170%2Cannotation%3A170',
    );
    expect(parseJBrowseShareParams(new URL(url).searchParams)).toEqual({
      kind: 'valid',
      state,
      warnings: [],
    });
  });

  it('URL-encodes special reference names instead of interpreting them as parameters', () => {
    const refName = 'NZ_CP012345.1 plasmid α&rev=1?#/segment';
    const url = new URL(buildJBrowseShareUrl(
      { origin: 'https://rapptor.example', pathname: '/genomes/GCA_1' },
      { ...state, refName },
    ));

    expect(url.searchParams.get('ref')).toBe(refName);
    expect(url.searchParams.get('rev')).toBe('0');
    expect(parseJBrowseShareParams(url.searchParams)).toMatchObject({
      kind: 'valid',
      state: { refName, reversed: false },
    });
  });

  it('preserves an explicitly empty track list as hidden-all', () => {
    const hidden = { ...state, tracks: [] };
    const url = new URL(buildJBrowseShareUrl(
      { origin: 'https://rapptor.example', pathname: '/genomes/GCA_1' },
      hidden,
    ));

    expect(url.searchParams.has('tracks')).toBe(true);
    expect(url.searchParams.get('tracks')).toBe('');
    expect(parseJBrowseShareParams(url.searchParams)).toEqual({ kind: 'valid', state: hidden, warnings: [] });
  });

  it('accepts reordered tracks and bounded fractional CSS-pixel heights', () => {
    const parsed = parseJBrowseShareParams(params(
      'view=1&ref=chr1&center=10&zoom=2e-2&rev=1&tracks=annotation:1000,sequence:20.5,promoters:99',
    ));

    expect(parsed).toEqual({
      kind: 'valid',
      state: {
        version: 1,
        refName: 'chr1',
        center: 10,
        bpPerPx: 0.02,
        reversed: true,
        tracks: [
          { token: 'annotation', height: 1000 },
          { token: 'sequence', height: 20.5 },
          { token: 'promoters', height: 99 },
        ],
      },
      warnings: [],
    });
  });

  it('distinguishes ordinary URLs from malformed share URLs', () => {
    expect(parseJBrowseShareParams(params('ref=chr1&center=1'))).toEqual({ kind: 'absent' });
    expect(parseJBrowseShareParams(params('view=2&ref=chr1&center=1&zoom=1&rev=0&tracks='))).toMatchObject({
      kind: 'invalid',
      warnings: expect.arrayContaining([expect.stringContaining('version')]),
    });
  });

  it.each([
    ['center zero', 'view=1&ref=chr1&center=0&zoom=1&rev=0&tracks='],
    ['center fraction', 'view=1&ref=chr1&center=1.5&zoom=1&rev=0&tracks='],
    ['center unsafe', 'view=1&ref=chr1&center=9007199254740992&zoom=1&rev=0&tracks='],
    ['zoom zero', 'view=1&ref=chr1&center=1&zoom=0&rev=0&tracks='],
    ['zoom infinity', 'view=1&ref=chr1&center=1&zoom=Infinity&rev=0&tracks='],
    ['zoom junk', 'view=1&ref=chr1&center=1&zoom=1px&rev=0&tracks='],
    ['bad reverse', 'view=1&ref=chr1&center=1&zoom=1&rev=true&tracks='],
    ['short height', 'view=1&ref=chr1&center=1&zoom=1&rev=0&tracks=sequence:19.9'],
    ['tall height', 'view=1&ref=chr1&center=1&zoom=1&rev=0&tracks=sequence:1001'],
    ['control in ref', 'view=1&ref=chr%00evil&center=1&zoom=1&rev=0&tracks='],
  ])('rejects invalid numeric or scalar input: %s', (_label, query) => {
    expect(parseJBrowseShareParams(params(query)).kind).toBe('invalid');
  });

  it('rejects duplicate parameters, duplicate tracks, unknown tokens, and injected layout strings', () => {
    const cases = [
      'view=1&ref=chr1&ref=chr2&center=1&zoom=1&rev=0&tracks=',
      'view=1&ref=chr1&center=1&zoom=1&rev=0&tracks=sequence:120,sequence:130',
      'view=1&ref=chr1&center=1&zoom=1&rev=0&tracks=secret:120',
      'view=1&ref=chr1&center=1&zoom=1&rev=0&tracks=https%3A%2F%2Fevil.test%2Fasset.bw%3A120',
      'view=1&ref=chr1&center=1&zoom=1&rev=0&tracks=sequence:120:javascript%3Aalert(1)',
    ];

    for (const query of cases) expect(parseJBrowseShareParams(params(query)).kind).toBe('invalid');
  });

  it('builds from only the origin and pathname and clears credentials, unknown query, and hash', () => {
    const url = new URL(buildJBrowseShareUrl(
      {
        origin: 'https://user:password@rapptor.example/?secret=yes#private',
        pathname: '/genomes/GCA_000411415.1',
      },
      state,
    ));

    expect(url.origin).toBe('https://rapptor.example');
    expect(url.pathname).toBe('/genomes/GCA_000411415.1');
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    expect(url.hash).toBe('');
    expect(url.searchParams.has('secret')).toBe(false);
    expect([...url.searchParams.keys()]).toEqual(['view', 'ref', 'center', 'zoom', 'rev', 'tracks']);
  });

  it('does not build links for external schemes or forged track tokens', () => {
    expect(() => buildJBrowseShareUrl(
      { origin: 'blob:https://rapptor.example/id', pathname: '/genomes/GCA_1' },
      state,
    )).toThrow(/HTTP/);
    expect(() => buildJBrowseShareUrl(
      { origin: 'https://rapptor.example', pathname: '/genomes/GCA_1' },
      {
        ...state,
        tracks: [{ token: 'https://evil.test/asset.bw' as 'sequence', height: 120 }],
      },
    )).toThrow(/Unknown shared track token/);
  });
});

describe('extractJBrowseShareState', () => {
  it('extracts the 1-based viewport center, exact zoom, direction, and registered visible tracks', () => {
    expect(extractJBrowseShareState(view(), registry)).toEqual({
      kind: 'valid',
      state: {
        version: 1,
        refName: 'CP003597.1',
        center: 200000,
        bpPerPx: 0.25,
        reversed: true,
        tracks: [
          { token: 'sequence', height: 122 },
          { token: 'promoters', height: 171 },
        ],
      },
      warnings: [],
    });
  });

  it('allows out-of-bounds edges at contig boundaries when the center is in bounds', () => {
    const extracted = extractJBrowseShareState(view({
      pxToBp: (px) => ({
        refName: 'CP003597.1',
        coord: px === 500 ? 4 : px === 0 ? -121 : 129,
        oob: px !== 500,
        reversed: false,
      }),
    }), registry);

    expect(extracted).toMatchObject({ kind: 'valid', state: { center: 4, reversed: false } });
  });

  it('rejects multi-reference and out-of-bounds-center views', () => {
    expect(extractJBrowseShareState(view({
      pxToBp: (px) => ({
        refName: px === 1000 ? 'plasmid' : 'chromosome',
        coord: 100,
        oob: false,
      }),
    }), registry)).toMatchObject({ kind: 'invalid', warnings: [expect.stringContaining('multiple')] });

    expect(extractJBrowseShareState(view({
      pxToBp: () => ({ refName: 'chromosome', coord: -1, oob: true }),
    }), registry)).toMatchObject({ kind: 'invalid', warnings: [expect.stringContaining('outside')] });
  });

  it('rejects multiple displayed regions even when sampled coordinates share one refName', () => {
    expect(extractJBrowseShareState(view({
      displayedRegions: [{ refName: 'CP003597.1' }, { refName: 'CP003597.1' }],
    }), registry)).toMatchObject({ kind: 'invalid', warnings: [expect.stringContaining('multiple')] });
  });

  it('rejects registered tracks without a bounded actual or pre-configured height', () => {
    expect(extractJBrowseShareState(view({
      tracks: [{ configuration: { trackId: registry.sequence }, displays: [{ height: 1001, heightPreConfig: 120 }] }],
    }), registry)).toMatchObject({ kind: 'invalid', warnings: [expect.stringContaining('height')] });
  });
});
