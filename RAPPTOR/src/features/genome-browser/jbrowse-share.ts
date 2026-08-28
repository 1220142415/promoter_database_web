export const SHARE_TRACK_TOKENS = ['sequence', 'scores', 'promoters', 'experimental', 'annotation'] as const;

export type ShareTrackToken = (typeof SHARE_TRACK_TOKENS)[number];

export interface JBrowseShareTrack {
  readonly token: ShareTrackToken;
  readonly height: number;
}

export interface JBrowseShareStateV1 {
  readonly version: 1;
  readonly refName: string;
  readonly center: number;
  readonly bpPerPx: number;
  readonly reversed: boolean;
  readonly tracks: readonly JBrowseShareTrack[];
}

export type ShareTrackRegistry = Readonly<Partial<Record<ShareTrackToken, string>>>;

export type JBrowseShareParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly warnings: readonly string[] }
  | { readonly kind: 'valid'; readonly state: JBrowseShareStateV1; readonly warnings: readonly string[] };

export type JBrowseShareExtractionResult =
  | { readonly kind: 'invalid'; readonly warnings: readonly string[] }
  | { readonly kind: 'valid'; readonly state: JBrowseShareStateV1; readonly warnings: readonly string[] };

interface ViewCoordinateLike {
  readonly refName: string;
  readonly coord: number;
  readonly oob: boolean;
  readonly reversed?: boolean;
}

interface DisplayLike {
  readonly height?: number;
  readonly heightPreConfig?: number;
}

interface VisibleTrackLike {
  readonly trackId?: string;
  readonly configuration?: string | { readonly trackId?: string };
  readonly displays?: readonly DisplayLike[];
}

interface DisplayedRegionLike {
  readonly refName: string;
}

export interface JBrowseShareViewLike {
  readonly width: number;
  readonly bpPerPx: number;
  readonly displayedRegions: readonly DisplayedRegionLike[];
  readonly tracks: readonly VisibleTrackLike[];
  pxToBp(px: number): ViewCoordinateLike;
}

const SHARE_PARAM_NAMES = ['view', 'ref', 'center', 'zoom', 'rev', 'tracks'] as const;
const REF_NAME_MAX_LENGTH = 255;
const TRACK_HEIGHT_MIN = 20;
const TRACK_HEIGHT_MAX = 1000;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;
const DECIMAL_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

function isShareTrackToken(value: string): value is ShareTrackToken {
  return (SHARE_TRACK_TOKENS as readonly string[]).includes(value);
}

function isValidRefName(value: string) {
  return value.length > 0
    && value.length <= REF_NAME_MAX_LENGTH
    && value.trim().length > 0
    && !CONTROL_CHARACTER.test(value);
}

function parsePositiveInteger(value: string | null) {
  if (value === null || !POSITIVE_INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePositiveNumber(value: string | null) {
  if (value === null || !DECIMAL_NUMBER.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isValidTrackHeight(value: number) {
  return Number.isFinite(value) && value >= TRACK_HEIGHT_MIN && value <= TRACK_HEIGHT_MAX;
}

function validateTracks(tracks: readonly JBrowseShareTrack[]) {
  const warnings: string[] = [];
  const seen = new Set<ShareTrackToken>();

  for (const track of tracks) {
    if (!isShareTrackToken(track.token)) {
      warnings.push(`Unknown shared track token: ${String(track.token)}.`);
      continue;
    }
    if (seen.has(track.token)) warnings.push(`Shared track ${track.token} appears more than once.`);
    seen.add(track.token);
    if (!isValidTrackHeight(track.height)) {
      warnings.push(`Shared track ${track.token} has an invalid height.`);
    }
  }

  return warnings;
}

function validateState(state: JBrowseShareStateV1) {
  const warnings: string[] = [];
  if (state.version !== 1) warnings.push('Unsupported shared browser view version.');
  if (!isValidRefName(state.refName)) warnings.push('The shared reference name is invalid.');
  if (!Number.isSafeInteger(state.center) || state.center < 1) warnings.push('The shared center coordinate is invalid.');
  if (!Number.isFinite(state.bpPerPx) || state.bpPerPx <= 0) warnings.push('The shared zoom level is invalid.');
  if (typeof state.reversed !== 'boolean') warnings.push('The shared orientation is invalid.');
  if (!Array.isArray(state.tracks)) warnings.push('The shared track layout is invalid.');
  else warnings.push(...validateTracks(state.tracks));
  return warnings;
}

function parseTracks(value: string | null) {
  const warnings: string[] = [];
  const tracks: JBrowseShareTrack[] = [];
  if (value === null) return { tracks, warnings: ['The shared track layout is missing.'] };
  if (value === '') return { tracks, warnings };

  const seen = new Set<ShareTrackToken>();
  for (const item of value.split(',')) {
    const match = /^([^:]+):([^:]+)$/u.exec(item);
    if (!match) {
      warnings.push('The shared track layout contains a malformed entry.');
      continue;
    }

    const [, rawToken, rawHeight] = match;
    if (!isShareTrackToken(rawToken)) {
      warnings.push(`Unknown shared track token: ${rawToken}.`);
      continue;
    }
    if (seen.has(rawToken)) {
      warnings.push(`Shared track ${rawToken} appears more than once.`);
      continue;
    }
    seen.add(rawToken);

    const height = parsePositiveNumber(rawHeight);
    if (height === null || !isValidTrackHeight(height)) {
      warnings.push(`Shared track ${rawToken} has an invalid height.`);
      continue;
    }
    tracks.push({ token: rawToken, height });
  }

  return { tracks, warnings };
}

export function parseJBrowseShareParams(params: URLSearchParams): JBrowseShareParseResult {
  if (!params.has('view')) return { kind: 'absent' };

  const warnings: string[] = [];
  for (const name of SHARE_PARAM_NAMES) {
    const count = params.getAll(name).length;
    if (count === 0) warnings.push(`The shared browser view is missing the ${name} parameter.`);
    else if (count > 1) warnings.push(`The shared browser view repeats the ${name} parameter.`);
  }

  if (params.get('view') !== '1') warnings.push('Unsupported shared browser view version.');

  const refName = params.get('ref');
  if (refName === null || !isValidRefName(refName)) warnings.push('The shared reference name is invalid.');

  const center = parsePositiveInteger(params.get('center'));
  if (center === null) warnings.push('The shared center coordinate is invalid.');

  const bpPerPx = parsePositiveNumber(params.get('zoom'));
  if (bpPerPx === null) warnings.push('The shared zoom level is invalid.');

  const rawReversed = params.get('rev');
  if (rawReversed !== '0' && rawReversed !== '1') warnings.push('The shared orientation is invalid.');

  const parsedTracks = parseTracks(params.get('tracks'));
  warnings.push(...parsedTracks.warnings);

  if (warnings.length > 0 || refName === null || center === null || bpPerPx === null) {
    return { kind: 'invalid', warnings };
  }

  return {
    kind: 'valid',
    state: {
      version: 1,
      refName,
      center,
      bpPerPx,
      reversed: rawReversed === '1',
      tracks: parsedTracks.tracks,
    },
    warnings: [],
  };
}

export function buildJBrowseShareUrl(
  base: Pick<Location, 'origin' | 'pathname'>,
  state: JBrowseShareStateV1,
) {
  const warnings = validateState(state);
  if (warnings.length > 0) throw new Error(warnings.join(' '));

  const url = new URL(base.origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Shared browser links require an HTTP(S) origin.');
  }
  url.username = '';
  url.password = '';
  url.pathname = base.pathname;
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', '1');
  url.searchParams.set('ref', state.refName);
  url.searchParams.set('center', String(state.center));
  url.searchParams.set('zoom', String(state.bpPerPx));
  url.searchParams.set('rev', state.reversed ? '1' : '0');
  url.searchParams.set('tracks', state.tracks.map(({ token, height }) => `${token}:${height}`).join(','));
  return url.toString();
}

function visibleTrackId(track: VisibleTrackLike) {
  if (typeof track.configuration === 'string') return track.configuration;
  if (track.configuration && typeof track.configuration.trackId === 'string') return track.configuration.trackId;
  return typeof track.trackId === 'string' ? track.trackId : null;
}

export function extractJBrowseShareState(
  view: JBrowseShareViewLike,
  registry: ShareTrackRegistry,
): JBrowseShareExtractionResult {
  if (!Number.isFinite(view.width) || view.width <= 0) {
    return { kind: 'invalid', warnings: ['The genome browser does not have a measurable viewport yet.'] };
  }
  if (!Number.isFinite(view.bpPerPx) || view.bpPerPx <= 0) {
    return { kind: 'invalid', warnings: ['The genome browser zoom level cannot be shared.'] };
  }
  if (!Array.isArray(view.displayedRegions) || view.displayedRegions.length !== 1) {
    return { kind: 'invalid', warnings: ['Views spanning multiple reference regions cannot be shared.'] };
  }

  let left: ViewCoordinateLike;
  let center: ViewCoordinateLike;
  let right: ViewCoordinateLike;
  try {
    left = view.pxToBp(0);
    center = view.pxToBp(view.width / 2);
    right = view.pxToBp(view.width);
  } catch {
    return { kind: 'invalid', warnings: ['The visible genome region could not be read.'] };
  }

  if (center.oob || !isValidRefName(center.refName) || !Number.isSafeInteger(center.coord) || center.coord < 1) {
    return { kind: 'invalid', warnings: ['The viewport center is outside a shareable reference region.'] };
  }
  if (left.refName !== center.refName || right.refName !== center.refName) {
    return { kind: 'invalid', warnings: ['Views spanning multiple reference regions cannot be shared.'] };
  }
  if (view.displayedRegions[0].refName !== center.refName) {
    return { kind: 'invalid', warnings: ['The viewport center does not match the displayed reference region.'] };
  }

  const idToToken = new Map<string, ShareTrackToken>();
  for (const token of SHARE_TRACK_TOKENS) {
    const trackId = registry[token];
    if (trackId === undefined) continue;
    if (!trackId || CONTROL_CHARACTER.test(trackId) || /^[a-z][a-z\d+.-]*:/iu.test(trackId)) {
      return { kind: 'invalid', warnings: [`The ${token} track registry entry is invalid.`] };
    }
    if (idToToken.has(trackId)) {
      return { kind: 'invalid', warnings: ['The shared track registry contains duplicate track identifiers.'] };
    }
    idToToken.set(trackId, token);
  }

  const tracks: JBrowseShareTrack[] = [];
  const seen = new Set<ShareTrackToken>();
  for (const track of view.tracks) {
    const trackId = visibleTrackId(track);
    const token = trackId === null ? undefined : idToToken.get(trackId);
    if (token === undefined) continue;
    if (seen.has(token)) {
      return { kind: 'invalid', warnings: [`Visible track ${token} appears more than once.`] };
    }
    seen.add(token);

    const display = track.displays?.[0];
    const height = display?.height ?? display?.heightPreConfig;
    if (height === undefined || !isValidTrackHeight(height)) {
      return { kind: 'invalid', warnings: [`Visible track ${token} does not have a shareable height.`] };
    }
    tracks.push({ token, height });
  }

  return {
    kind: 'valid',
    state: {
      version: 1,
      refName: center.refName,
      center: center.coord,
      bpPerPx: view.bpPerPx,
      reversed: center.reversed === true,
      tracks,
    },
    warnings: [],
  };
}
