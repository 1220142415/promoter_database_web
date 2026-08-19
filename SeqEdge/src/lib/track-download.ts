export type TrackDownloadKind = 'reference' | 'promoters' | 'ncbi' | 'scores-plus' | 'scores-minus';

export type TrackDownloadFormat = 'fasta' | 'gff3' | 'bigwig';

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
  downloadMode?: 'remote' | 'browser';
  visibleRegionDownload?: boolean;
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
  'scores-plus': {
    prefix: 'RAPPtor-raw-scores-plus',
    format: 'bigwig',
    regionExtension: '.bw',
    wholeExtension: '.bw',
  },
  'scores-minus': {
    prefix: 'RAPPtor-raw-scores-minus',
    format: 'bigwig',
    regionExtension: '.bw',
    wholeExtension: '.bw',
  },
};

const KNOWN_DATA_EXTENSION = /\.(?:gff3(?:\.gz)?|fa(?:sta)?(?:\.gz)?|fna(?:\.gz)?|bed|bw|bigwig|tsv|txt|gz)$/i;

export function trackDownloadSettings(kind: TrackDownloadKind) {
  return KIND_SETTINGS[kind];
}

export function isTrackDownloadMetadata(value: unknown): value is TrackDownloadMetadata {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Partial<TrackDownloadMetadata>;
  return (
    (metadata.kind === 'reference' || metadata.kind === 'promoters' || metadata.kind === 'ncbi' || metadata.kind === 'scores-plus' || metadata.kind === 'scores-minus')
    && typeof metadata.accession === 'string'
    && typeof metadata.label === 'string'
    && typeof metadata.regionExportBase === 'string'
    && typeof metadata.wholeAssetUrl === 'string'
    && (metadata.downloadMode === undefined || metadata.downloadMode === 'remote' || metadata.downloadMode === 'browser')
    && (metadata.visibleRegionDownload === undefined || typeof metadata.visibleRegionDownload === 'boolean')
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
  const wholeExtension = 'downloadMode' in metadata && metadata.downloadMode === 'browser'
    ? settings.regionExtension
    : settings.wholeExtension;
  return `${settings.prefix}_${metadata.accession}${wholeExtension}`;
}

export function requiredTrackDownloadExtension(
  metadata: TrackDownloadMetadata,
  scope: TrackDownloadScope,
) {
  const settings = KIND_SETTINGS[metadata.kind];
  return scope === 'visible' || metadata.downloadMode === 'browser'
    ? settings.regionExtension
    : settings.wholeExtension;
}

function wrappedSequence(sequence: string) {
  const lines = [];
  for (let offset = 0; offset < sequence.length; offset += 60) lines.push(sequence.slice(offset, offset + 60));
  return lines.join('\n');
}

function visibleFasta(text: string, region: TrackDownloadRegion) {
  let currentName = '';
  let sequence = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('>')) {
      if (currentName === region.refName) break;
      currentName = line.slice(1).trim().split(/\s+/, 1)[0] || '';
      sequence = '';
    } else if (currentName === region.refName) {
      sequence += line.replace(/\s+/g, '');
    }
  }
  if (currentName !== region.refName) throw new Error(`Reference sequence ${region.refName} was not found.`);
  if (region.start > sequence.length) throw new Error('The visible region starts beyond the reference sequence.');
  const end = Math.min(region.end, sequence.length);
  const selected = sequence.slice(region.start - 1, end);
  return `>${region.refName}:${region.start}-${end}\n${wrappedSequence(selected)}\n`;
}

function visibleGff3(text: string, region: TrackDownloadRegion) {
  const selected = ['##gff-version 3'];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 9 || fields[0] !== region.refName) continue;
    const start = Number(fields[3]);
    const end = Number(fields[4]);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= region.end && end >= region.start) {
      selected.push(line);
    }
  }
  return `${selected.join('\n')}\n`;
}

export async function browserTrackDownloadBlob(
  metadata: TrackDownloadMetadata,
  scope: TrackDownloadScope,
  region: TrackDownloadRegion | null,
) {
  const response = await fetch(metadata.wholeAssetUrl);
  if (!response.ok) throw new Error(`Cached genome data could not be read (HTTP ${response.status}).`);
  const source = await response.blob();
  if (scope === 'whole') return source;
  if (!region) throw new Error('A single visible reference region is required.');
  const text = await source.text();
  const exported = metadata.kind === 'reference' ? visibleFasta(text, region) : visibleGff3(text, region);
  return new Blob([exported], { type: 'text/plain; charset=utf-8' });
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
