import cyanobacteriaRelease from '@/generated/cyanobacteria-continuous-score-release.json';

/** Pin each assembly to verified continuous scores, independently of the peak release. */
export function cyanobacteriaContinuousScores(genomeId: string) {
  if (!Object.hasOwn(cyanobacteriaRelease.genomes, genomeId)) return null;
  const version = cyanobacteriaRelease.revision || cyanobacteriaRelease.version;
  const base = `/api/cyanobacteria-data/${genomeId}/v-${version}`;
  const names = ['promoter_scores.sigma1.plus.bw', 'promoter_scores.sigma1.minus.bw'];
  return {
    version,
    localVersion: cyanobacteriaRelease.version,
    files: Object.fromEntries(names.map(name => [name, cyanobacteriaRelease.revision
      ? `https://huggingface.co/datasets/${cyanobacteriaRelease.repository}/resolve/${cyanobacteriaRelease.revision}/${cyanobacteriaRelease.scorePath}/${genomeId}/${name}`
      : null])) as Record<string, string | null>,
    assets: { promoterScoresPlus: `${base}/${names[0]}`, promoterScoresMinus: `${base}/${names[1]}` },
  };
}
