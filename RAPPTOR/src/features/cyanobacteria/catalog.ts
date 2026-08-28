import releaseData from '@/generated/cyanobacteria-release.json';
import type {
  CyanobacteriaGenome,
  CyanobacteriaGenomeId,
  CyanobacteriaRelease,
} from '@/features/cyanobacteria/types';

export const cyanobacteriaRelease = releaseData as CyanobacteriaRelease;

const genomesById = new Map(
  cyanobacteriaRelease.genomes.map((genome) => [genome.id, genome]),
);

export function getCyanobacteriaGenome(value: string): CyanobacteriaGenome | null {
  return genomesById.get(value as CyanobacteriaGenomeId) || null;
}

export function cyanobacteriaReleaseFiles() {
  return new Set([
    cyanobacteriaRelease.manifest,
    cyanobacteriaRelease.checksums,
    cyanobacteriaRelease.releaseMetadata,
  ]);
}

export function cyanobacteriaGenomeFiles(genome: CyanobacteriaGenome) {
  return new Set(Object.values(genome.assets).filter((value): value is string => Boolean(value)));
}

export function cyanobacteriaAssetPath(genomeId: string, file: string) {
  return genomeId === 'release' ? file : `${genomeId}/${file}`;
}
