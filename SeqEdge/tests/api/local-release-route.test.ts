import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET, HEAD } from '@/app/api/local-release/[file]/route';

let root = '';

function context(file: string) {
  return { params: Promise.resolve({ file }) };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'seqedge-local-release-'));
  await writeFile(join(root, 'manifest.tsv'), 'path\tbytes\tsha256\n', 'utf8');
  process.env.LOCAL_RELEASE_ROOT = root;
});

afterAll(async () => {
  delete process.env.LOCAL_RELEASE_ROOT;
  await rm(root, { recursive: true, force: true });
});

describe('local release manifest route', () => {
  it('serves whitelisted release files and supports HEAD', async () => {
    const response = await GET(new Request('http://localhost/test'), context('manifest.tsv'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/tab-separated-values');
    expect(await response.text()).toBe('path\tbytes\tsha256\n');

    const head = await HEAD(new Request('http://localhost/test'), context('manifest.tsv'));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
  });

  it.each(['../manifest.tsv', 'objects.json', 'secrets.txt'])('rejects an unlisted path %s', async (file) => {
    const response = await GET(new Request('http://localhost/test'), context(file));
    expect(response.status).toBe(404);
  });
});
