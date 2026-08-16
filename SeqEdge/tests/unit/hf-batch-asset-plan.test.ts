import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Hugging Face batch asset plan', () => {
  it('generates compact batch ranges, explicit links, and a one-row D1 update', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'seqedge-hf-batches-'));
    temporaryRoots.push(root);
    const input = path.join(root, 'metadata.tsv');
    const output = path.join(root, 'plan');
    await writeFile(input, [
      'accession\torganismName',
      'GCA_000000001.1\tOne',
      'GCA_000000002.1\tTwo',
      'GCA_000000003.1\tThree',
      '',
    ].join('\n'));

    await execFileAsync(process.execPath, [
      path.resolve('scripts/build-hf-batch-asset-plan.mjs'),
      '--input', input,
      '--output', output,
      '--release', 'test-release',
      '--repo', 'owner/repository',
      '--batch-size', '2',
      '--expected-count', '3',
    ]);

    const plan = JSON.parse(await readFile(path.join(output, 'asset-layout.json'), 'utf8'));
    expect(plan).toMatchObject({ layout: 'promoter-batch-v1', totalGenomes: 3, batchSize: 2 });
    expect(plan.batches).toEqual([
      expect.objectContaining({ id: '000', firstAccession: 'GCA_000000001.1', lastAccession: 'GCA_000000002.1', count: 2, status: 'staged' }),
      expect.objectContaining({ id: '001', firstAccession: 'GCA_000000003.1', lastAccession: 'GCA_000000003.1', count: 1, status: 'staged' }),
    ]);

    const links = await readFile(path.join(output, 'asset-links.tsv'), 'utf8');
    expect(links.trim().split('\n')).toHaveLength(4);
    expect(links).toContain('https://huggingface.co/datasets/owner/repository/resolve/main/001/genomes/GCA_000000003.1_genomic.fna.gz');

    const sql = await readFile(path.join(output, 'update-release-asset-layout.sql'), 'utf8');
    expect(sql).toContain("hf_repository = 'owner/repository'");
    expect(sql).toContain("json_set(feature_summary_json, '$.assetLayout'");
    expect(sql.match(/UPDATE releases/g)).toHaveLength(1);
  });
});
