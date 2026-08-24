import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareHfPilot } from '../../scripts/prepare-hf-pilot.mjs';

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'rapptor-hf-pilot-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Hugging Face storage pilot preparation', () => {
  it('copies only selected accession objects while retaining release metadata', async () => {
    const projectRoot = await temporaryDirectory();
    const release = '2026-08-07';
    const releaseRoot = join(projectRoot, '.data', 'releases', release);
    const selected = 'GCA_000411415.1';
    const omitted = 'GCA_000421325.1';
    await mkdir(join(releaseRoot, 'objects', selected), { recursive: true });
    await mkdir(join(releaseRoot, 'objects', omitted), { recursive: true });
    await writeFile(join(releaseRoot, 'objects', selected, 'reference.fa.gz'), 'selected');
    await writeFile(join(releaseRoot, 'objects', omitted, 'reference.fa.gz'), 'omitted');
    await writeFile(join(releaseRoot, 'catalog.json'), '{}');
    await writeFile(join(releaseRoot, 'release.json'), '{}');
    await writeFile(join(releaseRoot, 'checksums.sha256'), 'digest  catalog.json\n');
    await writeFile(join(releaseRoot, 'manifest.tsv'), [
      'path\tbytes\tsha256',
      `objects/${selected}/reference.fa.gz\t8\tdigest-selected`,
      `objects/${omitted}/reference.fa.gz\t7\tdigest-omitted`,
      '',
    ].join('\n'));

    const result = await prepareHfPilot({ projectRoot, release, accessions: [selected] });
    expect(result).toMatchObject({ objectFiles: 1, objectBytes: 8 });
    expect(await readFile(join(result.targetRoot, 'objects', selected, 'reference.fa.gz'), 'utf8')).toBe('selected');
    await expect(readFile(join(result.targetRoot, 'objects', omitted, 'reference.fa.gz'))).rejects.toThrow();
    expect(await readFile(join(result.targetRoot, 'pilot-manifest.tsv'), 'utf8')).toContain(selected);
    expect(await readFile(join(result.targetRoot, 'pilot-manifest.tsv'), 'utf8')).not.toContain(omitted);
  });
});
