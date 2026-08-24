import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLegacyD1Import } from '../../scripts/build-legacy-d1-import.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('legacy D1 import', () => {
  it('writes the feature catalog schema while retaining rollback activation', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'rapptor-legacy-d1-'));
    temporaryRoots.push(projectRoot);
    const release = '2099-01-01';
    const sourceRoot = path.join(projectRoot, '.data', 'releases', release);
    await mkdir(sourceRoot, { recursive: true });
    const accession = 'GCA_000000001.1';
    const assets = {
      fasta: `${accession}/reference.fa.gz`,
      fastaFai: `${accession}/reference.fa.gz.fai`,
      fastaGzi: `${accession}/reference.fa.gz.gzi`,
      predictedPromoters: `${accession}/predicted-promoters.gff3.gz`,
      predictedPromotersIndex: `${accession}/predicted-promoters.gff3.gz.tbi`,
      promoterScoresPlus: `${accession}/promoter-scores.plus.bw`,
      promoterScoresMinus: `${accession}/promoter-scores.minus.bw`,
      ncbiAnnotations: `${accession}/ncbi-annotations.gff3.gz`,
      ncbiAnnotationsIndex: `${accession}/ncbi-annotations.gff3.gz.tbi`,
      metadata: `${accession}/metadata.json`,
    };
    await writeFile(path.join(sourceRoot, 'catalog.json'), JSON.stringify({
      summary: { totalPredictedPromoters: 7, annotatedGenomes: 1 },
      genomes: [{
        accession,
        organismName: 'Test bacterium',
        domain: 'Bacteria',
        phylum: 'Testota',
        predictedPromoterCount: 7,
        annotationStatus: 'available',
        annotationFeatureCount: 4,
        assets,
      }],
    }));
    await writeFile(path.join(sourceRoot, 'release.json'), JSON.stringify({ id: release, date: release }));

    const result = await buildLegacyD1Import({ projectRoot, release, repo: 'owner/pilot' });
    const releaseSql = await readFile(path.join(result.outputRoot, '000-release.sql'), 'utf8');
    const genomeSql = await readFile(path.join(result.outputRoot, '001-genomes.sql'), 'utf8');
    const activateSql = await readFile(path.join(result.outputRoot, 'activate-rollback.sql'), 'utf8');

    expect(releaseSql).toContain('storage_layout');
    expect(releaseSql).not.toContain('total_predicted_promoters');
    expect(genomeSql).toContain('reference_storage_json');
    expect(genomeSql.match(/INSERT INTO feature_sets /g)).toHaveLength(2);
    expect(genomeSql).toContain('promoter-scores.plus.bw');
    expect(genomeSql).toContain('promoter-scores.minus.bw');
    expect(genomeSql).not.toContain('predicted_promoter_count');
    expect(activateSql).toContain("active_release_id = excluded.active_release_id");
    expect(activateSql).not.toContain('UPDATE releases SET state');
  });
});
