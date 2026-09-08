import release from '@/generated/experimental-score-release.json';

const publishedAccessions = new Set(release.accessions);
const scoreBase = `https://huggingface.co/datasets/${release.repository}/resolve/${release.revision}/${release.collectionPath}/${release.scorePath}`;

/** Published, already-smoothed scores for the collection's full reference assemblies. */
export function experimentalScoreAssets(accession: string, referencePath: unknown, collectionBase: string | null) {
  const absent = { promoterScoresPlus: null, promoterScoresMinus: null };
  if (!publishedAccessions.has(accession) || referencePath !== `genome_sequences/${accession}.fna` || !collectionBase) return absent;
  let url: URL;
  try { url = new URL(collectionBase); } catch { return absent; }
  const prefix = `/datasets/${release.repository}/resolve/`;
  const path = url.pathname.replace(/\/+$/, '');
  // Older D1 catalogs pin the reference release before these scores were added.
  // Keep that reference pin; scores use their own verified release revision.
  if (url.origin !== 'https://huggingface.co' || !path.startsWith(prefix)
    || !/^[^/]+\/experimentally_supported_genomes$/.test(path.slice(prefix.length))) return absent;
  const base = `${scoreBase}/${accession}/${accession}.promoter_scores.sigma1`;
  return { promoterScoresPlus: `${base}.plus.bw`, promoterScoresMinus: `${base}.minus.bw` };
}
