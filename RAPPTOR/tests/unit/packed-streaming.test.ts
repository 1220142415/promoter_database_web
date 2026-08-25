import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPackedRelease } from '../../scripts/data/build-packed-release.mjs';
import { materializePackedSelection } from '../../scripts/data/materialize-packed-shard.mjs';
import { reclaimUploadedPacks } from '../../scripts/huggingface/reclaim-uploaded-pack.mjs';

const temporaryRoots: string[] = [];

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

async function createSourceRelease(projectRoot: string) {
  const source = '2099-01-01';
  const accession = 'GCA_000000001.1';
  const sourceRoot = path.join(projectRoot, '.data', 'releases', source);
  const objectRoot = path.join(sourceRoot, 'objects', accession);
  await mkdir(objectRoot, { recursive: true });
  const files = {
    'metadata.json': Buffer.from('{"accession":"GCA_000000001.1"}\n'),
    'reference.fa.gz': Buffer.from('small-test-reference-bytes'),
    'promoter-scores.plus.bw': Buffer.from('small-plus-bigwig-bytes'),
    'promoter-scores.minus.bw': Buffer.from('small-minus-bigwig-bytes'),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(objectRoot, name), bytes);
  const genome = {
    accession,
    organismName: 'Test bacterium',
    strain: 'streaming',
    domain: 'Bacteria',
    phylum: 'Testota',
    className: 'Testia',
    orderName: 'Testales',
    family: 'Testaceae',
    genus: 'Testus',
    genomeSource: 'GTDB',
    genomeSizeBp: null,
    predictedPromoterCount: 1,
    annotationStatus: 'missing',
    assets: {
      metadata: 'objects/' + accession + '/metadata.json',
      reference: 'objects/' + accession + '/reference.fa.gz',
      promoterScoresPlus: 'objects/' + accession + '/promoter-scores.plus.bw',
      promoterScoresMinus: 'objects/' + accession + '/promoter-scores.minus.bw',
    },
  };
  await writeFile(path.join(sourceRoot, 'catalog.json'), JSON.stringify({ summary: {}, genomes: [genome] }));
  await writeFile(path.join(sourceRoot, 'release.json'), JSON.stringify({ id: source, description: 'fixture' }));
  await writeFile(path.join(sourceRoot, 'manifest.tsv'), [
    'path\tbytes\tsha256',
    ...Object.entries(files).map(([name, bytes]) => 'objects/' + accession + '/' + name + '\t' + bytes.length + '\t' + sha256(bytes)),
    '',
  ].join('\n'));
  return { source, accession, files };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('streaming Pack lifecycle', () => {
  it('keeps the default build materialized for the existing 1,000-genome workflow', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'rapptor-pack-default-'));
    temporaryRoots.push(projectRoot);
    const fixture = await createSourceRelease(projectRoot);
    const release = '2099-01-03';
    const result = await buildPackedRelease({ projectRoot, source: fixture.source, sourceRelease: fixture.source, release });
    const releaseRoot = path.join(projectRoot, '.data', 'releases', release);
    const plan = JSON.parse(await readFile(path.join(releaseRoot, 'pack-plan.json'), 'utf8'));
    expect(result.planOnly).toBe(false);
    expect(plan.materialization).toBe('materialized');
    expect((await stat(path.join(releaseRoot, 'packs', path.posix.basename(plan.packs[0].path)))).isFile()).toBe(true);
    expect(JSON.parse(await readFile(path.join(releaseRoot, '.release-complete.json'), 'utf8')).state).toBe('complete');
    const releaseSql = await readFile(path.join(releaseRoot, 'd1', '000-release.sql'), 'utf8');
    const genomeSql = await readFile(path.join(releaseRoot, 'd1', '001-genomes.sql'), 'utf8');
    expect(releaseSql).toContain('storage_layout');
    expect(releaseSql).not.toContain('total_predicted_promoters');
    expect(genomeSql).toContain('reference_storage_json');
    expect(genomeSql.match(/INSERT INTO feature_sets /g)).toHaveLength(2);
    expect(genomeSql).toContain('promoter-scores.plus.bw');
    expect(genomeSql).toContain('promoter-scores.minus.bw');
    expect(genomeSql).not.toContain('predicted_promoter_count');
  }, 30_000);

  it('plans without Pack files, materializes one Pack, and only reclaims a remotely verified hash', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'rapptor-pack-stream-'));
    temporaryRoots.push(projectRoot);
    const fixture = await createSourceRelease(projectRoot);
    const release = '2099-01-02';
    const result = await buildPackedRelease({
      projectRoot,
      source: fixture.source,
      sourceRelease: fixture.source,
      release,
      planOnly: true,
    });

    expect(result.planOnly).toBe(true);
    const releaseRoot = path.join(projectRoot, '.data', 'releases', release);
    expect(await readdir(path.join(releaseRoot, 'packs'))).toEqual([]);
    await expect(stat(path.join(releaseRoot, '.release-complete.json'))).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(releaseRoot, '.release-plan-complete.json'), 'utf8')).state).toBe('planned');

    const plan = JSON.parse(await readFile(path.join(releaseRoot, 'pack-plan.json'), 'utf8'));
    expect(plan.materialization).toBe('plan-only');
    expect(plan.packs).toHaveLength(1);
    expect(plan.packs[0].entries).toHaveLength(4);
    expect(plan.packs[0].entries[1].offset).toBe(4096);
    expect(plan.packs[0].entries.every((entry: { sourcePath: string; sha256: string }) =>
      entry.sourcePath.startsWith('.data/releases/' + fixture.source + '/objects/') && /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);

    const packName = path.posix.basename(plan.packs[0].path);
    const materialized = await materializePackedSelection({ projectRoot, release, pack: packName });
    expect(materialized[0].status).toBe('materialized');
    const packPath = path.join(releaseRoot, 'packs', packName);
    expect((await stat(packPath)).size).toBe(plan.packs[0].bytes);
    const packBytes = await readFile(packPath);
    for (const entry of plan.packs[0].entries) {
      const expected = fixture.files[entry.file as keyof typeof fixture.files];
      expect(packBytes.subarray(entry.offset, entry.offset + entry.bytes)).toEqual(expected);
    }

    const stateRoot = path.join(projectRoot, '.data', 'upload-plans');
    await mkdir(stateRoot, { recursive: true });
    const batch = {
      status: 'complete',
      files: [{ kind: 'pack', remotePath: plan.packs[0].path, bytes: plan.packs[0].bytes, sha256: plan.packs[0].sha256 }],
    };
    await writeFile(path.join(stateRoot, release + '.json'), JSON.stringify({ schemaVersion: 1, release, batches: [batch] }));
    await expect(reclaimUploadedPacks({ projectRoot, release, pack: packName, delete: true })).rejects.toThrow(/remotely verified/);
    expect((await stat(packPath)).isFile()).toBe(true);

    Object.assign(batch, { verifiedAt: '2099-01-02T00:00:00.000Z' });
    await writeFile(path.join(stateRoot, release + '.json'), JSON.stringify({ schemaVersion: 1, release, batches: [batch] }));
    await expect(reclaimUploadedPacks({ projectRoot, release, pack: packName })).rejects.toThrow(/remotely verified/);
    expect((await stat(packPath)).isFile()).toBe(true);

    const commitId = 'a'.repeat(40);
    Object.assign(batch, {
      commitIds: [commitId],
      commitUrl: 'https://huggingface.co/datasets/owner/repo/commit/' + commitId,
    });
    await writeFile(path.join(stateRoot, release + '.json'), JSON.stringify({ schemaVersion: 1, release, batches: [batch] }));
    expect((await reclaimUploadedPacks({ projectRoot, release, pack: packName }))[0].status).toBe('would-delete');
    expect((await stat(packPath)).isFile()).toBe(true);
    expect((await reclaimUploadedPacks({ projectRoot, release, pack: packName, delete: true }))[0].status).toBe('deleted');
    await expect(stat(packPath)).rejects.toThrow();
    expect((await stat(path.join(projectRoot, plan.packs[0].entries[0].sourcePath))).isFile()).toBe(true);
    expect((await reclaimUploadedPacks({ projectRoot, release, pack: packName, delete: true }))[0].status).toBe('already-absent');
  }, 30_000);
});
