#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

function parseArgs(argv) {
  const options = { release: '2026-08-11', endpoint: 'http://[::1]:9223', wsEndpoint: null, maxBatches: Infinity, reclaimVerifiedPacks: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--release') options.release = argv[++index];
    else if (argv[index] === '--endpoint') options.endpoint = argv[++index];
    else if (argv[index] === '--ws-endpoint') options.wsEndpoint = argv[++index];
    else if (argv[index] === '--max-batches') {
      options.maxBatches = Number(argv[++index]);
      if (!Number.isSafeInteger(options.maxBatches) || options.maxBatches < 0) throw new Error('--max-batches must be a non-negative integer');
    }
    else if (argv[index] === '--reclaim-verified-packs') options.reclaimVerifiedPacks = true;
    else throw new Error('Unknown argument: ' + argv[index]);
  }
  return options;
}

async function savePlan(file, plan) {
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(plan, null, 2) + '\n');
  await rename(temporary, file);
}

function requestJson(urlValue) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, { headers: { Accept: 'application/json' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('CDP endpoint returned HTTP ' + response.statusCode + '.'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error('CDP endpoint timed out.')));
    request.on('error', reject);
  });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function gitBlobHash(file, bytes) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    hash.update('blob ' + bytes + '\0');
    const input = createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function requireLoopbackUrl(value, protocols) {
  const parsed = new URL(value);
  if (!protocols.includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Open Browser CDP must use a loopback-only endpoint.');
  }
}

export class RemoteBatchMissingError extends Error {
  constructor(message, missingPaths = []) {
    super(message);
    this.name = 'RemoteBatchMissingError';
    this.code = 'REMOTE_BATCH_MISSING';
    this.missingPaths = [...missingPaths];
  }
}

export function buildDatasetTreeUrl(repo, revision, directory) {
  const repoParts = repo.split('/');
  if (repoParts.length !== 2 || repoParts.some((part) => !part)) throw new Error('Invalid Hugging Face dataset repository.');
  const encodedRepo = repoParts.map(encodeURIComponent).join('/');
  const encodedDirectory = directory.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return 'https://huggingface.co/api/datasets/' + encodedRepo + '/tree/' + encodeURIComponent(revision)
    + (encodedDirectory ? '/' + encodedDirectory : '') + '?expand=true';
}

export function buildDatasetPageUrl(repo) {
  const repoParts = repo.split('/');
  if (repoParts.length !== 2 || repoParts.some((part) => !part)) throw new Error('Invalid Hugging Face dataset repository.');
  return 'https://huggingface.co/datasets/' + repoParts.map(encodeURIComponent).join('/');
}

export function summarizeResponseBody(value, limit = 300) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty response body)';
  return normalized.length <= limit ? normalized : normalized.slice(0, limit) + '...';
}

export function evaluateUploadHydration(snapshot, expectedNames) {
  const expected = [...expectedNames].sort();
  const selected = [...(snapshot?.selectedFileNames || [])].sort();
  const selectedMatches = selected.length === expected.length && selected.every((name, index) => name === expected[index]);
  const selectionWasConsumed = selected.length === 0 && snapshot?.allNamesVisible && snapshot?.summaryReady;
  if (!selectedMatches && !selectionWasConsumed) {
    return { ready: false, reason: 'selected files do not match the expected batch' };
  }
  if (!snapshot?.allNamesVisible) return { ready: false, reason: 'not all expected filenames are rendered' };
  if (!snapshot?.summaryReady) return { ready: false, reason: 'commit summary is not ready' };
  if (!snapshot?.commitButtonPresent) return { ready: false, reason: 'Commit changes button is missing' };
  if (snapshot.commitButtonDisabled) return { ready: false, reason: 'Commit changes button is disabled' };
  return { ready: true, reason: null };
}

/** @param {string} endpoint @param {string | null} [wsEndpoint] */
export async function resolveCdpWebSocket(endpoint, wsEndpoint = null) {
  if (wsEndpoint) {
    requireLoopbackUrl(wsEndpoint, ['ws:', 'wss:']);
    return wsEndpoint;
  }
  requireLoopbackUrl(endpoint, ['http:', 'https:']);
  const version = await requestJson(endpoint.replace(/\/+$/, '') + '/json/version');
  if (!version || typeof version.webSocketDebuggerUrl !== 'string') throw new Error('Open Browser CDP endpoint did not report webSocketDebuggerUrl.');
  requireLoopbackUrl(version.webSocketDebuggerUrl, ['ws:', 'wss:']);
  return version.webSocketDebuggerUrl;
}

async function verifyLocalBatch(batch, projectRoot, release, { allowMissingPacks = false } = {}) {
  for (const file of batch.files) {
    const exists = await stat(file.localPath).then(() => true).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error));
    if (file.kind === 'pack' && !exists && allowMissingPacks) continue;
    if (file.kind === 'pack' && !exists) {
      const { materializePackedSelection } = await import('./materialize-packed-shard.mjs');
      await materializePackedSelection({ projectRoot, release, pack: path.basename(file.localPath) });
      file.materialized = true;
    }
    if (await hashFile(file.localPath) !== file.sha256) throw new Error(file.remotePath + ': local SHA-256 changed after upload plan creation.');
    if (file.kind === 'metadata' && !file.gitBlobSha1) file.gitBlobSha1 = await gitBlobHash(file.localPath, file.bytes);
  }
}

async function fetchRemoteDirectory(page, plan, batch) {
  const url = buildDatasetTreeUrl(plan.repo, plan.revision, batch.remoteDirectory);
  let pageOrigin = null;
  try { pageOrigin = new URL(page.url()).origin; } catch { /* Navigate non-URL pages such as about:blank. */ }
  if (pageOrigin !== 'https://huggingface.co') {
    await page.goto(buildDatasetPageUrl(plan.repo), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  const result = await page.evaluate(async ({ initialUrl, expectedPrefix }) => {
    const entries = [];
    let nextUrl = initialUrl;
    for (let pageNumber = 0; pageNumber < 1_000 && nextUrl; pageNumber += 1) {
      let response;
      try {
        response = await fetch(nextUrl, { credentials: 'include', headers: { Accept: 'application/json' } });
      } catch (error) {
        return { kind: 'network-error', message: error instanceof Error ? error.message : String(error) };
      }
      const body = await response.text();
      if (response.status === 404) return { kind: 'missing', status: 404, statusText: response.statusText, body };
      if (!response.ok) return { kind: 'http-error', status: response.status, statusText: response.statusText, body };
      let pageEntries;
      try {
        pageEntries = JSON.parse(body);
      } catch (error) {
        return { kind: 'invalid-response', message: 'invalid JSON: ' + (error instanceof Error ? error.message : String(error)), body };
      }
      if (!Array.isArray(pageEntries)) return { kind: 'invalid-response', message: 'response body is not an array', body };
      entries.push(...pageEntries);
      const link = response.headers.get('link') || '';
      const nextMatch = link.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
      if (!nextMatch) return { kind: 'ok', entries };
      const candidate = new URL(nextMatch[1], response.url || initialUrl);
      if (candidate.origin !== 'https://huggingface.co' || !candidate.pathname.startsWith(expectedPrefix)) {
        return { kind: 'invalid-response', message: 'unsafe pagination URL', body: candidate.href };
      }
      nextUrl = candidate.href;
    }
    return { kind: 'invalid-response', message: 'tree pagination exceeded 1,000 pages', body: '' };
  }, {
    initialUrl: url,
    expectedPrefix: new URL(url).pathname,
  });
  if (result?.kind === 'ok') return result.entries;
  if (result?.kind === 'missing') {
    throw new RemoteBatchMissingError(
      'Hugging Face directory is missing (HTTP 404). Response: ' + summarizeResponseBody(result.body),
      batch.files.map((file) => file.remotePath),
    );
  }
  if (result?.kind === 'http-error') {
    throw new Error('Hugging Face tree verification returned HTTP ' + result.status
      + (result.statusText ? ' ' + result.statusText : '') + '. Response: ' + summarizeResponseBody(result.body));
  }
  if (result?.kind === 'network-error') throw new Error('Hugging Face tree verification network error: ' + summarizeResponseBody(result.message));
  throw new Error('Hugging Face tree verification returned an invalid response: '
    + summarizeResponseBody(result?.message) + '. Response: ' + summarizeResponseBody(result?.body));
}

export async function verifyRemoteBatch(page, plan, batch, { attempts = 12, intervalMs = 5_000, retryErrors = false } = {}) {
  let mismatches = [];
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let entries;
    try {
      entries = await fetchRemoteDirectory(page, plan, batch);
      lastError = null;
    } catch (error) {
      lastError = error;
      if (!(error instanceof RemoteBatchMissingError) && !retryErrors) throw error;
      if (attempt + 1 < attempts) await page.waitForTimeout(intervalMs);
      continue;
    }
    const byPath = new Map(entries.filter((entry) => entry && typeof entry.path === 'string').map((entry) => [entry.path, entry]));
    mismatches = [];
    const conflicts = [];
    for (const file of batch.files) {
      const entry = byPath.get(file.remotePath);
      const remoteLfsSha = entry?.lfs?.oid || entry?.lfs?.sha256;
      const matches = entry && Number(entry.size) === file.bytes && (file.kind === 'pack'
        ? remoteLfsSha === file.sha256 && Number(entry.lfs?.size) === file.bytes
        : remoteLfsSha ? remoteLfsSha === file.sha256 : entry.oid === file.gitBlobSha1);
      if (!matches) {
        mismatches.push(file.remotePath);
        if (entry) conflicts.push(file.remotePath);
      }
    }
    if (conflicts.length) throw new Error('Immutable release conflict at ' + conflicts.slice(0, 5).join(', ') + (conflicts.length > 5 ? ' and ' + (conflicts.length - 5) + ' more.' : '.'));
    if (!mismatches.length) {
      const fileCommitIds = batch.files.map((file) => byPath.get(file.remotePath)?.lastCommit?.id);
      if (fileCommitIds.some((commitId) => typeof commitId !== 'string' || !/^[0-9a-f]{40,64}$/i.test(commitId))) {
        lastError = new Error('Remote files match, but valid commit evidence is missing.');
        if (attempt + 1 < attempts) await page.waitForTimeout(intervalMs);
        continue;
      }
      const commitIds = [...new Set(fileCommitIds)];
      const commitId = commitIds[0];
      return {
        verifiedAt: new Date().toISOString(),
        remoteRevision: commitId,
        commitIds,
        commitUrl: 'https://huggingface.co/datasets/' + plan.repo + '/commit/' + commitId,
      };
    }
    lastError = new RemoteBatchMissingError('Remote files are explicitly missing: ' + mismatches.slice(0, 5).join(', ')
      + (mismatches.length > 5 ? ' and ' + (mismatches.length - 5) + ' more.' : '.'), mismatches);
    if (attempt + 1 < attempts) await page.waitForTimeout(intervalMs);
  }
  throw lastError || new Error('Remote verification failed without a diagnostic.');
}

export async function waitForUploadHydration(page, expectedNames, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = { ready: false, reason: 'upload page has not been inspected' };
  while (Date.now() < deadline) {
    let snapshot;
    try {
      snapshot = await page.evaluate((names) => {
        const enabledInputs = [...document.querySelectorAll('input[type="file"]:not([disabled])')];
        const selectedInput = enabledInputs.find((input) => input instanceof HTMLInputElement && input.files?.length);
        const selectedFileNames = selectedInput instanceof HTMLInputElement && selectedInput.files
          ? [...selectedInput.files].map((file) => file.name)
          : [];
        const bodyText = document.body?.innerText || '';
        const summary = document.querySelector('input[name="summary"]');
        const countMatch = summary instanceof HTMLInputElement ? summary.placeholder.match(/^Upload (\d+) files?$/i) : null;
        const commitButton = [...document.querySelectorAll('button')]
          .find((button) => /commit changes/i.test(button.textContent || ''));
        return {
          selectedFileNames,
          allNamesVisible: names.every((name) => bodyText.includes(name)),
          summaryReady: summary instanceof HTMLInputElement && !summary.disabled && Number(countMatch?.[1]) === names.length,
          commitButtonPresent: Boolean(commitButton),
          commitButtonDisabled: commitButton instanceof HTMLButtonElement ? commitButton.disabled : true,
        };
      }, expectedNames);
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      latest = { ready: false, reason: 'upload page is navigating' };
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      continue;
    }
    latest = evaluateUploadHydration(snapshot, expectedNames);
    if (latest.ready) return;
    await page.waitForTimeout(250);
  }
  throw new Error('Hugging Face upload page did not hydrate the complete batch: ' + latest.reason + '.');
}

export async function uploadWithOpenBrowser({ projectRoot, release, endpoint, wsEndpoint, maxBatches, reclaimVerifiedPacks = false }) {
  const planPath = path.join(projectRoot, '.data', 'upload-plans', release + '.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(await resolveCdpWebSocket(endpoint, wsEndpoint));
  const context = browser.contexts()[0];
  if (!context) throw new Error('Open Browser CDP session has no browser context.');
  let completed = 0;
  for (const batch of plan.batches) {
    if (batch.status === 'complete') {
      const auditPage = await context.newPage();
      try {
        await verifyLocalBatch(batch, projectRoot, release, { allowMissingPacks: true });
        const verification = await verifyRemoteBatch(auditPage, plan, batch);
        Object.assign(batch, verification);
        delete batch.error;
        await savePlan(planPath, plan);
        continue;
      } catch (error) {
        batch.error = error instanceof Error ? 'Remote recheck failed: ' + error.message : 'Remote recheck failed: ' + String(error);
        if (error instanceof RemoteBatchMissingError) {
          batch.status = 'pending';
          delete batch.commitUrl;
          delete batch.commitIds;
          delete batch.remoteRevision;
          delete batch.completedAt;
          await savePlan(planPath, plan);
        } else {
          await savePlan(planPath, plan);
          throw error;
        }
      } finally {
        await auditPage.close();
      }
    }
    if (completed >= maxBatches) break;
    let uploadFiles = batch.files;
    const preflightPage = await context.newPage();
    try {
      await verifyLocalBatch(batch, projectRoot, release, { allowMissingPacks: true });
      const verification = await verifyRemoteBatch(preflightPage, plan, batch, { attempts: 1 });
      Object.assign(batch, verification, { status: 'complete', completedAt: verification.verifiedAt });
      delete batch.error;
      completed += 1;
      await savePlan(planPath, plan);
      console.log('Recovered already-uploaded ' + batch.id + ': ' + (batch.commitUrl || batch.remoteRevision));
      continue;
    } catch (error) {
      if (!(error instanceof RemoteBatchMissingError)) {
        batch.status = 'failed';
        batch.error = error instanceof Error ? error.message : String(error);
        await savePlan(planPath, plan);
        throw error;
      }
      if (error.missingPaths.length) {
        const missingPaths = new Set(error.missingPaths);
        uploadFiles = batch.files.filter((file) => missingPaths.has(file.remotePath));
        if (!uploadFiles.length) throw new Error('Remote preflight reported missing paths outside the current batch.');
      }
      // HTTP 404 or an otherwise successful listing with absent paths is the
      // only state that authorizes creating immutable release objects.
    } finally {
      await preflightPage.close();
    }
    batch.attempts += 1;
    batch.status = 'uploading';
    await savePlan(planPath, plan);
    const page = await context.newPage();
    try {
      const uploadBatch = { ...batch, files: uploadFiles };
      await verifyLocalBatch(uploadBatch, projectRoot, release);
      const uploadUrl = 'https://huggingface.co/datasets/' + plan.repo + '/upload/' + plan.revision + '/' + batch.remoteDirectory;
      await page.goto(uploadUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (await page.getByText('Log In', { exact: true }).count()) throw new Error('The Open Browser automation profile is not logged in to Hugging Face.');
      await page.locator('input[name="summary"]').waitFor({ state: 'attached', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
      await page.locator('input[type="file"]:not([disabled])').first().setInputFiles(uploadFiles.map((file) => file.localPath));
      await waitForUploadHydration(page, uploadFiles.map((file) => path.basename(file.remotePath)));
      await page.locator('input[name="summary"]').fill('Upload SeqEdge ' + plan.release + ' ' + batch.id);
      await page.getByRole('button', { name: /Commit changes/ }).click({ timeout: 120_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => undefined);
      Object.assign(batch, await verifyRemoteBatch(page, plan, batch, {
        attempts: 720,
        intervalMs: 10_000,
        retryErrors: true,
      }));
      batch.status = 'complete';
      batch.completedAt = new Date().toISOString();
      delete batch.error;
      completed += 1;
      await savePlan(planPath, plan);
      if (reclaimVerifiedPacks && batch.files.every((file) => file.kind === 'pack')) {
        const { reclaimUploadedPacks } = await import('./reclaim-uploaded-pack.mjs');
        for (const file of batch.files) {
          await reclaimUploadedPacks({ projectRoot, release, pack: path.basename(file.localPath), delete: true });
          file.materialized = false;
        }
        await savePlan(planPath, plan);
      }
      console.log('Uploaded ' + batch.id + ': ' + batch.commitUrl);
    } catch (error) {
      batch.status = 'failed';
      batch.error = error instanceof Error ? error.message : String(error);
      await savePlan(planPath, plan);
      throw error;
    } finally {
      await page.close();
    }
  }
  // The browser belongs to the user. Let process exit disconnect CDP without
  // closing the dedicated Open Browser window or its authenticated profile.
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await uploadWithOpenBrowser({ projectRoot, ...options });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
