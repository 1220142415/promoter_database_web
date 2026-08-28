import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BgzipIndexedFasta } from '@gmod/indexedfasta';
import { TabixIndexedFile } from '@gmod/tabix';
import { LocalFile, RemoteFile } from 'generic-filehandle2';
import { cyanobacteriaRelease, getCyanobacteriaGenome } from '@/features/cyanobacteria/catalog';

const REF_NAME = /^[A-Za-z0-9_.:-]+$/;
const TRACKS = new Set(['promoters', 'experimental-tss', 'annotation']);
const MAX_REGION_BP = 5_000_000;

export type CyanobacteriaRegionExportInput = {
  genomeId: string;
  refName: string;
  start: number;
  end: number;
  tracks: string[];
};

export type CyanobacteriaRegionExportFormat = 'fasta' | 'gff3';

function localRoot() {
  return process.env.CYANOBACTERIA_DATA_ROOT
    || join(process.cwd(), '.data', 'cyanobacteria', 'releases', cyanobacteriaRelease.releaseId);
}

function remoteBase() {
  return (process.env.CYANOBACTERIA_ASSET_BASE_URL || cyanobacteriaRelease.assetBaseUrl).replace(/\/+$/, '');
}

function wrapFasta(sequence: string) {
  return sequence.match(/.{1,80}/g)?.join('\n') || '';
}

export function validateCyanobacteriaRegionExport(input: CyanobacteriaRegionExportInput, requireTracks = true) {
  const genome = getCyanobacteriaGenome(input.genomeId);
  if (!genome) throw new Error('Invalid cyanobacteria genome identifier.');
  if (!REF_NAME.test(input.refName)) throw new Error('Invalid reference sequence name.');
  if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end) || input.start < 1 || input.end < input.start) {
    throw new Error('Invalid genomic interval.');
  }
  if (input.end - input.start + 1 > MAX_REGION_BP) throw new Error('Genomic interval exceeds the 5 Mb export limit.');
  if (input.tracks.some((track) => !TRACKS.has(track))) throw new Error('Invalid annotation track.');
  const tracks = [...new Set(input.tracks)].filter((track) => TRACKS.has(track));
  if (tracks.includes('experimental-tss') && (!genome.assets.experimentalTss || !genome.assets.experimentalTssIndex)) {
    throw new Error('Experimental TSS evidence is not available for this genome.');
  }
  if (requireTracks && !tracks.length) throw new Error('Select at least one annotation track.');
  return { ...input, tracks };
}

function localHandles(genomeId: string) {
  const root = join(localRoot(), genomeId);
  const fasta = join(root, 'reference.fa.gz');
  if (!existsSync(fasta)) return null;
  return {
    fasta: new LocalFile(fasta),
    fai: new LocalFile(`${fasta}.fai`),
    gzi: new LocalFile(`${fasta}.gzi`),
    promoters: new LocalFile(join(root, 'predicted-promoters.gff3.gz')),
    promoterIndex: new LocalFile(join(root, 'predicted-promoters.gff3.gz.tbi')),
    annotation: new LocalFile(join(root, 'genome-annotations.gff3.gz')),
    annotationIndex: new LocalFile(join(root, 'genome-annotations.gff3.gz.tbi')),
    experimentalTss: new LocalFile(join(root, 'experimentally-supported-tss.gff3.gz')),
    experimentalTssIndex: new LocalFile(join(root, 'experimentally-supported-tss.gff3.gz.tbi')),
  };
}

function remoteHandles(genomeId: string) {
  const root = `${remoteBase()}/${encodeURIComponent(genomeId)}`;
  const remote = (file: string) => new RemoteFile(`${root}/${file}`);
  return {
    fasta: remote('reference.fa.gz'),
    fai: remote('reference.fa.gz.fai'),
    gzi: remote('reference.fa.gz.gzi'),
    promoters: remote('predicted-promoters.gff3.gz'),
    promoterIndex: remote('predicted-promoters.gff3.gz.tbi'),
    annotation: remote('genome-annotations.gff3.gz'),
    annotationIndex: remote('genome-annotations.gff3.gz.tbi'),
    experimentalTss: remote('experimentally-supported-tss.gff3.gz'),
    experimentalTssIndex: remote('experimentally-supported-tss.gff3.gz.tbi'),
  };
}

export async function exportCyanobacteriaRegion(
  input: CyanobacteriaRegionExportInput,
  format: CyanobacteriaRegionExportFormat = 'gff3',
) {
  const region = validateCyanobacteriaRegionExport(input, format === 'gff3');
  const useRemote = Boolean(process.env.CYANOBACTERIA_ASSET_BASE_URL)
    || (process.env.NODE_ENV === 'production' && !process.env.CYANOBACTERIA_DATA_ROOT);
  const handles = useRemote
    ? remoteHandles(region.genomeId)
    : localHandles(region.genomeId) || remoteHandles(region.genomeId);
  const locus = `${region.refName}:${region.start}-${region.end}`;
  if (format === 'fasta') {
    const indexed = new BgzipIndexedFasta({ fasta: handles.fasta, fai: handles.fai, gzi: handles.gzi });
    const sequence = await indexed.getSequence(region.refName, region.start - 1, region.end);
    if (sequence === undefined) throw new Error('Reference sequence is not available for this genome.');
    return { locus, data: Buffer.from(`>${locus}\n${wrapFasta(sequence)}\n`, 'utf8') };
  }

  const blocks = ['##gff-version 3', `##source-region ${locus}`];
  for (const track of region.tracks) {
    const indexed = track === 'promoters'
      ? new TabixIndexedFile({ filehandle: handles.promoters, tbiFilehandle: handles.promoterIndex })
      : track === 'experimental-tss'
        ? new TabixIndexedFile({ filehandle: handles.experimentalTss, tbiFilehandle: handles.experimentalTssIndex })
        : new TabixIndexedFile({ filehandle: handles.annotation, tbiFilehandle: handles.annotationIndex });
    const lines: string[] = [];
    await indexed.getLines(region.refName, region.start - 1, region.end, (line) => lines.push(line));
    blocks.push(`##source-track ${track}`);
    if (lines.length) blocks.push(lines.join('\n'));
  }
  return { locus, data: Buffer.from(`${blocks.join('\n')}\n`, 'utf8') };
}
