import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BgzipIndexedFasta } from '@gmod/indexedfasta';
import { TabixIndexedFile } from '@gmod/tabix';
import { LocalFile } from 'generic-filehandle2';
import { genomeCatalogRepository } from '@/features/genomes/repository';

const ACCESSION = /^GC[AF]_\d{9}\.\d+$/;
const REF_NAME = /^[A-Za-z0-9_.:-]+$/;
const TRACKS = new Set(['promoters', 'ncbi']);

export type RegionExportInput = {
  accession: string;
  refName: string;
  start: number;
  end: number;
  tracks: string[];
};

export type RegionExportFormat = 'fasta' | 'gff3';

function dataRoot(releaseId: string) {
  return process.env.LOCAL_DATA_ROOT || join(process.cwd(), '.data', 'releases', releaseId, 'objects');
}

function wrapFasta(sequence: string) {
  return sequence.match(/.{1,80}/g)?.join('\n') || '';
}

export function validateRegionExport(input: RegionExportInput, requireTracks = true) {
  if (!ACCESSION.test(input.accession)) throw new Error('Invalid genome accession.');
  if (!REF_NAME.test(input.refName)) throw new Error('Invalid reference sequence name.');
  if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end) || input.start < 1 || input.end < input.start) {
    throw new Error('Invalid genomic interval.');
  }
  if (input.tracks.some((track) => !TRACKS.has(track))) throw new Error('Invalid annotation track.');
  const tracks = [...new Set(input.tracks)].filter((track) => TRACKS.has(track));
  if (requireTracks && !tracks.length) throw new Error('Select at least one annotation track.');
  return { ...input, tracks };
}

export async function exportRegion(input: RegionExportInput, format: RegionExportFormat = 'gff3') {
  const region = validateRegionExport(input, format === 'gff3');
  const match = await genomeCatalogRepository.getByAccession(region.accession);
  if (!match || match.resourceStatus === 'staged' || !match.storage) throw new Error('Genome release assets are not available locally.');
  const objectRoot = join(dataRoot(match.releaseId), match.storage.logicalObjectPrefix);
  const fasta = join(objectRoot, 'reference.fa.gz');
  const promoters = join(objectRoot, 'predicted-promoters.gff3.gz');
  const ncbi = join(objectRoot, 'ncbi-annotations.gff3.gz');
  if (!existsSync(fasta) || !existsSync(promoters)) throw new Error('Genome release assets are not available locally.');
  const locus = `${region.refName}:${region.start}-${region.end}`;
  if (format === 'fasta') {
    const indexed = new BgzipIndexedFasta({
      fasta: new LocalFile(fasta),
      fai: new LocalFile(`${fasta}.fai`),
      gzi: new LocalFile(`${fasta}.gzi`),
    });
    const sequence = await indexed.getSequence(region.refName, region.start - 1, region.end);
    if (sequence === undefined) throw new Error('Reference sequence is not available for this genome.');
    return { accession: region.accession, locus, sequence: Buffer.from(`>${locus}\n${wrapFasta(sequence)}\n`, 'utf8'), gff3: Buffer.alloc(0), tracks: region.tracks };
  }
  const blocks = ['##gff-version 3', `##source-region ${locus}`];
  for (const track of region.tracks) {
    const path = track === 'promoters' ? promoters : ncbi;
    if (!existsSync(path)) throw new Error(`${track === 'ncbi' ? 'NCBI annotation' : 'Promoter'} track is not available for this genome.`);
    const indexed = new TabixIndexedFile({ path, tbiPath: `${path}.tbi` });
    const lines: string[] = [];
    await indexed.getLines(region.refName, region.start - 1, region.end, (line) => lines.push(line));
    blocks.push(`##source-track ${track}`);
    if (lines.length) blocks.push(lines.join('\n'));
  }
  return { accession: region.accession, locus, sequence: Buffer.alloc(0), gff3: Buffer.from(`${blocks.join('\n')}\n`, 'utf8'), tracks: region.tracks };
}
