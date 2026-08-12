export type TrackDownloadKind = 'reference' | 'promoters' | 'ncbi';

export type TrackDownloadFormat = 'fasta' | 'gff3';

export type TrackDownloadScope = 'visible' | 'whole';

export interface TrackDownloadRegion {
  refName: string;
  start: number;
  end: number;
}

export interface TrackDownloadMetadata {
  kind: TrackDownloadKind;
  accession: string;
  label: string;
  regionExportBase: string;
  wholeAssetUrl: string;
}

export type LinearViewLike = {
  width: number;
  pxToBp: (px: number) => { refName: string; coord: number };
};

const KIND_SETTINGS: Record<TrackDownloadKind, {
  prefix: string;
  format: TrackDownloadFormat;
  regionExtension: string;
  wholeExtension: string;
  track?: 'promoters' | 'ncbi';
}> = {
  reference: {
    prefix: 'reference',
    format: 'fasta',
    regionExtension: '.fa',
    wholeExtension: '.fa.gz',
  },
  promoters: {
    prefix: 'RAPPtor-promoters',
    format: 'gff3',
    regionExtension: '.gff3',
    wholeExtension: '.gff3.gz',
    track: 'promoters',
  },
  ncbi: {
    prefix: 'NCBI-annotation',
    format: 'gff3',
    regionExtension: '.gff3',
    wholeExtension: '.gff3.gz',
    track: 'ncbi',
  },
};

const KNOWN_DATA_EXTENSION = /\.(?:gff3(?:\.gz)?|fa(?:sta)?(?:\.gz)?|fna(?:\.gz)?|bed|tsv|txt|gz)$/i;

export function trackDownloadSettings(kind: TrackDownloadKind) {
  return KIND_SETTINGS[kind];
}

export function isTrackDownloadMetadata(value: unknown): value is TrackDownloadMetadata {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Partial<TrackDownloadMetadata>;
  return (
    (metadata.kind === 'reference' || metadata.kind === 'promoters' || metadata.kind === 'ncbi')
    && typeof metadata.accession === 'string'
    && typeof metadata.label === 'string'
    && typeof metadata.regionExportBase === 'string'
    && typeof metadata.wholeAssetUrl === 'string'
  );
}

export function visibleTrackRegion(view: LinearViewLike): TrackDownloadRegion | null {
  if (!Number.isFinite(view.width) || view.width <= 0) return null;
  const left = view.pxToBp(0);
  const right = view.pxToBp(view.width);
  if (!left.refName || left.refName !== right.refName) return null;
  const start = Math.max(1, Math.floor(Math.min(left.coord, right.coord)));
  const end = Math.max(start, Math.ceil(Math.max(left.coord, right.coord)) - 1);
  return { refName: left.refName, start, end };
}

export function defaultTrackDownloadFilename(
  metadata: Pick<TrackDownloadMetadata, 'kind' | 'accession'>,
  scope: TrackDownloadScope,
  region: TrackDownloadRegion | null,
) {
  const settings = KIND_SETTINGS[metadata.kind];
  if (scope === 'visible' && region) {
    return `${settings.prefix}_${metadata.accession}_${region.refName}_${region.start}-${region.end}${settings.regionExtension}`;
  }
  return `${settings.prefix}_${metadata.accession}${settings.wholeExtension}`;
}

export function normalizeDownloadFilename(input: string | null | undefined, requiredExtension: string, fallback: string) {
  const stripRequiredExtension = (value: string) => value.toLowerCase().endsWith(requiredExtension.toLowerCase())
    ? value.slice(0, -requiredExtension.length)
    : value;
  const fallbackStem = stripRequiredExtension(fallback).replace(KNOWN_DATA_EXTENSION, '');
  const lastPathPart = (input || '').split(/[\\/]/).pop() || '';
  let stem = stripRequiredExtension(lastPathPart)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(KNOWN_DATA_EXTENSION, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  if (!stem) stem = fallbackStem;
  const maxStemLength = Math.max(1, 180 - requiredExtension.length);
  stem = stem.slice(0, maxStemLength).replace(/[._-]+$/g, '') || fallbackStem.slice(0, maxStemLength);
  return `${stem}${requiredExtension}`;
}

export function regionTrackDownloadUrl(
  metadata: TrackDownloadMetadata,
  region: TrackDownloadRegion,
  filename: string,
) {
  const settings = KIND_SETTINGS[metadata.kind];
  const params = new URLSearchParams({
    ref: region.refName,
    start: String(region.start),
    end: String(region.end),
    format: settings.format,
    filename,
  });
  if (settings.track) params.set('tracks', settings.track);
  return `${metadata.regionExportBase.replace(/\/+$/, '')}/${encodeURIComponent(metadata.accession)}?${params.toString()}`;
}

export function wholeTrackDownloadUrl(metadata: TrackDownloadMetadata, filename: string) {
  const separator = metadata.wholeAssetUrl.includes('?') ? '&' : '?';
  return `${metadata.wholeAssetUrl}${separator}filename=${encodeURIComponent(filename)}`;
}
