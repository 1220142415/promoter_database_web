import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteBatchMissingError,
  buildDatasetPageUrl,
  buildDatasetTreeUrl,
  evaluateUploadHydration,
  resolveCdpWebSocket,
  summarizeResponseBody,
  verifyRemoteBatch,
  waitForUploadHydration,
} from '../../scripts/upload-hf-open-browser.mjs';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe('Open Browser CDP discovery', () => {
  it('reads a loopback CDP endpoint without fetch/proxy environment handling', async () => {
    const server = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://[::1]:9223/devtools/browser/test' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address unavailable.');
    await expect(resolveCdpWebSocket('http://127.0.0.1:' + address.port)).resolves.toBe('ws://[::1]:9223/devtools/browser/test');
  });

  it('accepts an explicit ws endpoint and rejects unrelated schemes', async () => {
    await expect(resolveCdpWebSocket('http://unused', 'ws://[::1]:9223/devtools/browser/test')).resolves.toContain('/devtools/browser/test');
    await expect(resolveCdpWebSocket('http://unused', 'https://example.test')).rejects.toThrow('loopback-only');
    await expect(resolveCdpWebSocket('https://remote.example.test')).rejects.toThrow('loopback-only');
  });
});

const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const plan = { repo: 'owner/repo', revision: 'main' };
const batch = {
  remoteDirectory: 'releases/2026-08-11/catalog',
  files: [
    { remotePath: 'releases/2026-08-11/catalog/a.json', kind: 'metadata', bytes: 3, gitBlobSha1: 'blob-a', sha256: '1'.repeat(64) },
    { remotePath: 'releases/2026-08-11/catalog/b.json', kind: 'metadata', bytes: 4, gitBlobSha1: 'blob-b', sha256: '2'.repeat(64) },
  ],
};

function fakePage(result: unknown) {
  return {
    url: () => 'https://huggingface.co/datasets/owner/repo',
    goto: async () => undefined,
    evaluate: async () => result,
    waitForTimeout: async () => undefined,
  };
}

function matchingEntries(commits = [commitA, commitA]) {
  return batch.files.map((file, index) => ({
    path: file.remotePath,
    size: file.bytes,
    oid: file.gitBlobSha1,
    lastCommit: commits[index] ? { id: commits[index] } : undefined,
  }));
}

describe('Hugging Face remote upload preflight', () => {
  it('uses the compatible non-recursive tree endpoint without an invalid limit', () => {
    const url = buildDatasetTreeUrl('owner/repo', 'main', 'releases/2026-08-11/catalog');
    expect(url).toBe('https://huggingface.co/api/datasets/owner/repo/tree/main/releases/2026-08-11/catalog?expand=true');
    expect(url).not.toContain('recursive');
    expect(url).not.toContain('limit');
    expect(buildDatasetPageUrl('owner/repo')).toBe('https://huggingface.co/datasets/owner/repo');
  });

  it('navigates blank preflight pages to the dataset origin before credentialed API fetches', async () => {
    const navigations: string[] = [];
    const page = {
      ...fakePage({ kind: 'ok', entries: matchingEntries() }),
      url: () => 'about:blank',
      goto: async (url: string) => { navigations.push(url); },
    };

    await expect(verifyRemoteBatch(page, plan, batch, { attempts: 1 })).resolves.toMatchObject({ commitIds: [commitA] });
    expect(navigations).toEqual(['https://huggingface.co/datasets/owner/repo']);
  });

  it.each([400, 401, 403, 429, 500, 503])('fails closed on HTTP %s and includes a response summary', async (status) => {
    const page = fakePage({ kind: 'http-error', status, statusText: 'Failure', body: '  diagnostic\nbody  ' });
    await expect(verifyRemoteBatch(page, plan, batch, { attempts: 1 })).rejects.toThrow(
      `HTTP ${status} Failure. Response: diagnostic body`,
    );
  });

  it('fails closed on a network error', async () => {
    const page = fakePage({ kind: 'network-error', message: 'connection reset' });
    await expect(verifyRemoteBatch(page, plan, batch, { attempts: 1 })).rejects.toThrow('network error: connection reset');
  });

  it('allows only HTTP 404 or explicitly absent files to enter the upload path', async () => {
    const notFound = fakePage({ kind: 'missing', status: 404, statusText: 'Not Found', body: 'missing' });
    await expect(verifyRemoteBatch(notFound, plan, batch, { attempts: 1 })).rejects.toBeInstanceOf(RemoteBatchMissingError);

    const absent = fakePage({ kind: 'ok', entries: matchingEntries().slice(0, 1) });
    await expect(verifyRemoteBatch(absent, plan, batch, { attempts: 1 })).rejects.toMatchObject({
      name: 'RemoteBatchMissingError',
      missingPaths: [batch.files[1].remotePath],
    });
  });

  it('fails on an existing immutable object with mismatched metadata', async () => {
    const entries = matchingEntries();
    entries[0].size += 1;
    const page = fakePage({ kind: 'ok', entries });
    await expect(verifyRemoteBatch(page, plan, batch, { attempts: 1 })).rejects.toThrow('Immutable release conflict');
  });

  it('requires commit evidence for every file and records all contributing commits', async () => {
    const missingEvidence = fakePage({ kind: 'ok', entries: matchingEntries([commitA, '']) });
    await expect(verifyRemoteBatch(missingEvidence, plan, batch, { attempts: 1 })).rejects.toThrow('valid commit evidence is missing');

    const multipleCommits = fakePage({ kind: 'ok', entries: matchingEntries([commitA, commitB]) });
    await expect(verifyRemoteBatch(multipleCommits, plan, batch, { attempts: 1 })).resolves.toMatchObject({
      commitIds: [commitA, commitB],
      commitUrl: `https://huggingface.co/datasets/owner/repo/commit/${commitA}`,
    });
  });

  it('summarizes noisy or oversized error bodies', () => {
    expect(summarizeResponseBody('  first\n second  ')).toBe('first second');
    expect(summarizeResponseBody('abcdef', 3)).toBe('abc...');
  });
});

describe('Hugging Face upload hydration', () => {
  const expected = ['a.bin', 'b.bin'];

  it('requires the exact selected batch, rendered names, summary, and enabled commit button', () => {
    expect(evaluateUploadHydration({
      selectedFileNames: expected,
      allNamesVisible: true,
      summaryReady: true,
      commitButtonPresent: true,
      commitButtonDisabled: false,
    }, expected)).toEqual({ ready: true, reason: null });

    expect(evaluateUploadHydration({
      selectedFileNames: [],
      allNamesVisible: true,
      summaryReady: true,
      commitButtonPresent: true,
      commitButtonDisabled: false,
    }, expected)).toEqual({ ready: true, reason: null });

    expect(evaluateUploadHydration({
      selectedFileNames: ['a.bin'],
      allNamesVisible: true,
      summaryReady: true,
      commitButtonPresent: true,
      commitButtonDisabled: false,
    }, expected)).toMatchObject({ ready: false });

    expect(evaluateUploadHydration({
      selectedFileNames: expected,
      allNamesVisible: false,
      summaryReady: true,
      commitButtonPresent: true,
      commitButtonDisabled: false,
    }, expected)).toMatchObject({ ready: false });

    expect(evaluateUploadHydration({
      selectedFileNames: expected,
      allNamesVisible: true,
      summaryReady: true,
      commitButtonPresent: true,
      commitButtonDisabled: true,
    }, expected)).toMatchObject({ ready: false });
  });

  it('retries hydration inspection across a transient page navigation', async () => {
    const waitForLoadState = vi.fn(async () => undefined);
    const page = {
      evaluate: vi.fn()
        .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation'))
        .mockResolvedValueOnce({
          selectedFileNames: expected,
          allNamesVisible: true,
          summaryReady: true,
          commitButtonPresent: true,
          commitButtonDisabled: false,
        }),
      waitForLoadState,
      waitForTimeout: async () => undefined,
    };

    await expect(waitForUploadHydration(page, expected, 1_000)).resolves.toBeUndefined();
    expect(waitForLoadState).toHaveBeenCalledWith('domcontentloaded', { timeout: 30_000 });
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });
});
