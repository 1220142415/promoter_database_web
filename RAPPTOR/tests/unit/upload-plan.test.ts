import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createUploadPlan } from '../../scripts/huggingface/create-upload-plan.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Hugging Face upload plan', () => {
  it('groups batches by remote directory and records content hashes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'rapptor-upload-plan-'));
    temporaryDirectories.push(projectRoot);
    const release = '2026-08-11';
    const root = join(projectRoot, '.data', 'releases', release);
    await Promise.all(['packs', 'manifests', 'catalog'].map((directory) => mkdir(join(root, directory), { recursive: true })));
    await writeFile(join(root, 'packs', 'pack-00-000.bin'), 'pack');
    const packSha256 = createHash('sha256').update('pack').digest('hex');
    await writeFile(join(root, 'packs-manifest.tsv'), 'path\tbytes\tsha256\nreleases/2026-08-11/packs/pack-00-000.bin\t4\t' + packSha256 + '\n');
    const rootFiles = ['release.json', 'catalog.json', 'manifest.tsv', 'checksums.sha256', 'manifest-index.json'];
    await Promise.all(rootFiles.map((file) => writeFile(join(root, file), file)));
    for (let index = 0; index < 256; index += 1) {
      const shard = index.toString(16).padStart(2, '0');
      await writeFile(join(root, 'manifests', 'manifest-' + shard + '.tsv.gz'), shard);
      await writeFile(join(root, 'manifests', 'checksums-' + shard + '.sha256.gz'), shard);
      await writeFile(join(root, 'catalog', 'genomes-' + shard + '.ndjson.gz'), shard);
    }
    const result = await createUploadPlan({ projectRoot, release, repo: 'owner/repo' });
    const plan = JSON.parse(await readFile(result.output, 'utf8'));
    expect(new Set(plan.batches.map((batch: { remoteDirectory: string }) => batch.remoteDirectory))).toEqual(new Set([
      'releases/2026-08-11', 'releases/2026-08-11/packs', 'releases/2026-08-11/manifests', 'releases/2026-08-11/catalog',
    ]));
    expect(plan.batches.flatMap((batch: { files: unknown[] }) => batch.files)).toHaveLength(775);
    expect(plan.batches.every((batch: { bytes: number; files: Array<{ kind: string }> }) => batch.bytes <= 2 * 1024 * 1024 * 1024 && batch.files.length <= (batch.files.some((file) => file.kind === 'pack') ? 20 : 100))).toBe(true);
    expect(plan.batches.flatMap((batch: { files: Array<{ gitBlobSha1: string }> }) => batch.files).every((file: { gitBlobSha1: string }) => /^[0-9a-f]{40}$/.test(file.gitBlobSha1))).toBe(true);

    plan.batches[0].status = 'complete';
    plan.batches[0].attempts = 1;
    plan.batches[0].commitUrl = 'https://huggingface.co/datasets/owner/repo/commit/abc';
    await writeFile(result.output, JSON.stringify(plan));
    const resumed = await createUploadPlan({ projectRoot, release, repo: 'owner/repo' });
    expect(resumed.plan.batches[0]).toMatchObject({ status: 'complete', attempts: 1, commitUrl: 'https://huggingface.co/datasets/owner/repo/commit/abc' });

    await writeFile(join(root, 'pack-plan.json'), JSON.stringify({
      schemaVersion: 1,
      releaseId: release,
      materialization: 'plan-only',
      packs: [{ path: 'releases/2026-08-11/packs/pack-00-000.bin', bytes: 4, sha256: packSha256 }],
    }));
    await rm(join(root, 'packs', 'pack-00-000.bin'));
    const plannedOnly = await createUploadPlan({ projectRoot, release, repo: 'owner/repo' });
    const plannedPack = plannedOnly.plan.batches
      .flatMap((batch: { files: Array<{ kind: string; materialized?: boolean }> }) => batch.files)
      .find((file: { kind: string }) => file.kind === 'pack');
    expect(plannedPack).toMatchObject({ materialized: false, gitBlobSha1: null });
  }, 30_000);

  it.each([
    {
      name: 'invalid hashes',
      rows: 'releases/2026-08-11/packs/pack-00-000.bin\t4\tINVALID',
      message: /invalid SHA-256/,
    },
    {
      name: 'duplicate remote paths',
      rows: [
        'releases/2026-08-11/packs/pack-00-000.bin\t4\t' + 'a'.repeat(64),
        'releases/2026-08-11/packs/pack-00-000.bin\t4\t' + 'a'.repeat(64),
      ].join('\n'),
      message: /Duplicate remote path/,
    },
    {
      name: 'single files larger than 2 GiB',
      rows: 'releases/2026-08-11/packs/pack-00-000.bin\t2147483649\t' + 'a'.repeat(64),
      message: /exceeds the 2 GiB/,
    },
  ])('rejects $name before creating a plan', async ({ rows, message }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'rapptor-upload-plan-invalid-'));
    temporaryDirectories.push(projectRoot);
    const root = join(projectRoot, '.data', 'releases', '2026-08-11');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'packs-manifest.tsv'), 'path\tbytes\tsha256\n' + rows + '\n');
    await expect(createUploadPlan({ projectRoot, release: '2026-08-11', repo: 'owner/repo' })).rejects.toThrow(message);
  });

  it('rejects a missing Pack when no materialization plan exists', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'rapptor-upload-plan-missing-pack-'));
    temporaryDirectories.push(projectRoot);
    const root = join(projectRoot, '.data', 'releases', '2026-08-11');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'packs-manifest.tsv'),
      'path\tbytes\tsha256\nreleases/2026-08-11/packs/pack-00-000.bin\t4\t' + 'a'.repeat(64) + '\n',
    );

    await expect(createUploadPlan({ projectRoot, release: '2026-08-11', repo: 'owner/repo' }))
      .rejects.toThrow(/local Pack is missing and no pack-plan definition is available/);
  });

  it('rejects Pack plan metadata that differs from the physical manifest', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'rapptor-upload-plan-mismatch-'));
    temporaryDirectories.push(projectRoot);
    const release = '2026-08-11';
    const root = join(projectRoot, '.data', 'releases', release);
    await mkdir(root, { recursive: true });
    const remotePath = 'releases/2026-08-11/packs/pack-00-000.bin';
    await writeFile(join(root, 'packs-manifest.tsv'), 'path\tbytes\tsha256\n' + remotePath + '\t4\t' + 'a'.repeat(64) + '\n');
    await writeFile(join(root, 'pack-plan.json'), JSON.stringify({
      schemaVersion: 1,
      releaseId: release,
      materialization: 'plan-only',
      packs: [{ path: remotePath, bytes: 5, sha256: 'b'.repeat(64) }],
    }));

    await expect(createUploadPlan({ projectRoot, release, repo: 'owner/repo' }))
      .rejects.toThrow(/pack-plan\.json differs from Pack manifest/);
  });

  it('rejects malformed repository identifiers without touching release data', async () => {
    await expect(createUploadPlan({ projectRoot: 'unused', release: '2026-08-11', repo: 'not-a-repo' })).rejects.toThrow(/Invalid Hugging Face dataset repo/);
  });
});
