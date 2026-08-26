export const EXPERIMENTAL_SHARE_STATIC_TRACKS = ['sequence', 'annotation'] as const;

export type ExperimentalShareStaticTrack = (typeof EXPERIMENTAL_SHARE_STATIC_TRACKS)[number];
export type ExperimentalShareTrackToken = ExperimentalShareStaticTrack | `study:${string}`;

export interface ExperimentalJBrowseShareTrack {
  readonly token: ExperimentalShareTrackToken;
  readonly height: number;
}

export interface ExperimentalJBrowseShareStateV1 {
  readonly version: 1;
  readonly refName: string;
  readonly center: number;
  readonly bpPerPx: number;
  readonly reversed: boolean;
  readonly tracks: readonly ExperimentalJBrowseShareTrack[];
}

export interface ExperimentalShareTrackRegistry {
  readonly sequence: string;
  readonly annotation?: string;
  readonly studies: Readonly<Record<string, string>>;
}

export type ExperimentalJBrowseShareParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly warnings: readonly string[] }
  | { readonly kind: 'valid'; readonly state: ExperimentalJBrowseShareStateV1; readonly warnings: readonly string[] };

export type ExperimentalJBrowseShareExtractionResult =
  | { readonly kind: 'invalid'; readonly warnings: readonly string[] }
  | { readonly kind: 'valid'; readonly state: ExperimentalJBrowseShareStateV1; readonly warnings: readonly string[] };

interface ViewCoordinateLike {
  readonly refName: string;
  readonly coord: number;
  readonly oob: boolean;
  readonly reversed?: boolean;
}

interface VisibleTrackLike {
  readonly trackId?: string;
  readonly configuration?: string | { readonly trackId?: string };
  readonly displays?: readonly { readonly height?: number; readonly heightPreConfig?: number }[];
}

export interface ExperimentalJBrowseShareViewLike {
  readonly width: number;
  readonly bpPerPx: number;
  readonly displayedRegions: readonly { readonly refName: string }[];
  readonly tracks: readonly VisibleTrackLike[];
  pxToBp(px: number): ViewCoordinateLike;
}

const SHARE_PARAM_NAMES = ['view', 'ref', 'center', 'zoom', 'rev', 'tracks'] as const;
const REF_NAME_MAX_LENGTH = 255;
const STUDY_ID_MAX_LENGTH = 128;
const TRACK_HEIGHT_MIN = 20;
const TRACK_HEIGHT_MAX = 1000;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const STUDY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;
const DECIMAL_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

function isValidRefName(value: string) {
  return value.length > 0
    && value.length <= REF_NAME_MAX_LENGTH
    && value.trim().length > 0
    && !CONTROL_CHARACTER.test(value);
}

export function isValidExperimentalStudyId(value: string) {
  return value.length <= STUDY_ID_MAX_LENGTH && STUDY_ID.test(value) && !CONTROL_CHARACTER.test(value);
}

export function experimentalStudyTrackToken(studyId: string): `study:${string}` {
  if (!isValidExperimentalStudyId(studyId)) throw new Error(`Invalid experimental study ID: ${studyId}`);
  return `study:${studyId}`;
}

function serializedTrackToken(token: ExperimentalShareTrackToken) {
  return token.startsWith('study:') ? `study.${token.slice('study:'.length)}` : token;
}

function parseTrackToken(value: string, allowedStudyIds: ReadonlySet<string>): ExperimentalShareTrackToken | null {
  if ((EXPERIMENTAL_SHARE_STATIC_TRACKS as readonly string[]).includes(value)) {
    return value as ExperimentalShareStaticTrack;
  }
  if (!value.startsWith('study.')) return null;
  const studyId = value.slice('study.'.length);
  return isValidExperimentalStudyId(studyId) && allowedStudyIds.has(studyId)
    ? experimentalStudyTrackToken(studyId)
    : null;
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

function parseTracks(value: string | null, allowedStudyIds: ReadonlySet<string>) {
  const warnings: string[] = [];
  const tracks: ExperimentalJBrowseShareTrack[] = [];
  if (value === null) return { tracks, warnings: ['The shared track layout is missing.'] };
  if (value === '') return { tracks, warnings };

  const seen = new Set<ExperimentalShareTrackToken>();
  for (const entry of value.split(',')) {
    const separator = entry.lastIndexOf(':');
    if (separator <= 0 || separator === entry.length - 1) {
      warnings.push('The shared track layout contains a malformed entry.');
      continue;
    }
    const rawToken = entry.slice(0, separator);
    const token = parseTrackToken(rawToken, allowedStudyIds);
    if (!token) {
      warnings.push(`Unknown or unavailable shared track token: ${rawToken}.`);
      continue;
    }
    if (seen.has(token)) {
      warnings.push(`Shared track ${rawToken} appears more than once.`);
      continue;
    }
    seen.add(token);
    const height = parsePositiveNumber(entry.slice(separator + 1));
    if (height === null || !isValidTrackHeight(height)) {
      warnings.push(`Shared track ${rawToken} has an invalid height.`);
      continue;
    }
    tracks.push({ token, height });
  }
  return { tracks, warnings };
}

export function parseExperimentalJBrowseShareParams(
  params: URLSearchParams,
  allowedStudyIds: ReadonlySet<string>,
): ExperimentalJBrowseShareParseResult {
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
  const parsedTracks = parseTracks(params.get('tracks'), allowedStudyIds);
  warnings.push(...parsedTracks.warnings);

  if (warnings.length || refName === null || center === null || bpPerPx === null) {
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

function validateState(state: ExperimentalJBrowseShareStateV1, allowedStudyIds: ReadonlySet<string>) {
  const warnings: string[] = [];
  if (state.version !== 1) warnings.push('Unsupported shared browser view version.');
  if (!isValidRefName(state.refName)) warnings.push('The shared reference name is invalid.');
  if (!Number.isSafeInteger(state.center) || state.center < 1) warnings.push('The shared center coordinate is invalid.');
  if (!Number.isFinite(state.bpPerPx) || state.bpPerPx <= 0) warnings.push('The shared zoom level is invalid.');
  const seen = new Set<ExperimentalShareTrackToken>();
  for (const track of state.tracks) {
    const serialized = serializedTrackToken(track.token);
    if (!parseTrackToken(serialized, allowedStudyIds)) warnings.push(`Unknown or unavailable shared track token: ${serialized}.`);
    if (seen.has(track.token)) warnings.push(`Shared track ${serialized} appears more than once.`);
    seen.add(track.token);
    if (!isValidTrackHeight(track.height)) warnings.push(`Shared track ${serialized} has an invalid height.`);
  }
  return warnings;
}

export function buildExperimentalJBrowseShareUrl(
  base: Pick<Location, 'origin' | 'pathname'>,
  state: ExperimentalJBrowseShareStateV1,
  allowedStudyIds: ReadonlySet<string>,
) {
  const warnings = validateState(state, allowedStudyIds);
  if (warnings.length) throw new Error(warnings.join(' '));
  const url = new URL(base.origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Shared browser links require an HTTP(S) origin.');
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
  url.searchParams.set('tracks', state.tracks.map(({ token, height }) => `${serializedTrackToken(token)}:${height}`).join(','));
  return url.toString();
}

function visibleTrackId(track: VisibleTrackLike) {
  if (typeof track.configuration === 'string') return track.configuration;
  if (track.configuration && typeof track.configuration.trackId === 'string') return track.configuration.trackId;
  return typeof track.trackId === 'string' ? track.trackId : null;
}

export function extractExperimentalJBrowseShareState(
  view: ExperimentalJBrowseShareViewLike,
  registry: ExperimentalShareTrackRegistry,
): ExperimentalJBrowseShareExtractionResult {
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
  if (left.refName !== center.refName || right.refName !== center.refName || view.displayedRegions[0].refName !== center.refName) {
    return { kind: 'invalid', warnings: ['Views spanning multiple reference regions cannot be shared.'] };
  }

  const idToToken = new Map<string, ExperimentalShareTrackToken>();
  const registrations: ReadonlyArray<readonly [ExperimentalShareTrackToken, string | undefined]> = [
    ['sequence', registry.sequence],
    ['annotation', registry.annotation],
    ...Object.entries(registry.studies).map(([studyId, trackId]) => [experimentalStudyTrackToken(studyId), trackId] as const),
  ];
  for (const [token, trackId] of registrations) {
    if (trackId === undefined) continue;
    if (!trackId || CONTROL_CHARACTER.test(trackId) || /^[a-z][a-z\d+.-]*:/iu.test(trackId) || idToToken.has(trackId)) {
      return { kind: 'invalid', warnings: ['The shared track registry contains an invalid or duplicate track identifier.'] };
    }
    idToToken.set(trackId, token);
  }

  const tracks: ExperimentalJBrowseShareTrack[] = [];
  const seen = new Set<ExperimentalShareTrackToken>();
  for (const track of view.tracks) {
    const trackId = visibleTrackId(track);
    const token = trackId === null ? undefined : idToToken.get(trackId);
    if (!token) continue;
    if (seen.has(token)) return { kind: 'invalid', warnings: [`Visible track ${serializedTrackToken(token)} appears more than once.`] };
    seen.add(token);
    const display = track.displays?.[0];
    const height = display?.height ?? display?.heightPreConfig;
    if (height === undefined || !isValidTrackHeight(height)) {
      return { kind: 'invalid', warnings: [`Visible track ${serializedTrackToken(token)} does not have a shareable height.`] };
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
