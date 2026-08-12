#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_COMMIT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PACKS = 20;
const MAX_METADATA_FILES = 100;

function hashFileDigests(file, bytes) {
  return new Promise((resolve, reject) => {
    const sha256 = createHash('sha256');
    const gitBlob = createHash('sha1').update('blob ' + bytes + '\0');
    const input = createReadStream(file);
    input.on('data', (chunk) => {
      sha256.update(chunk);
      gitBlob.update(chunk);
    });
    input.on('error', reject);
    input.on('end', () => resolve({ sha256: sha256.digest('hex'), gitBlobSha1: gitBlob.digest('hex') }));
  });
}

function assertSafeRemotePath(remotePath, release) {
  const escapedRelease = release.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^releases/' + escapedRelease + '/packs/pack-[0-9a-f]{2}-[0-9]{3}\\.bin$');
  if (!pattern.test(remotePath) || path.posix.normalize(remotePath) !== remotePath) {
    throw new Error('Invalid Pack remote path: ' + remotePath);
  }
}

function parseArgs(argv) {
  const options = { release: '2026-08-11', repo: 'liurulong/bacterial-promoter-genomes' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--release') options.release = argv[++index];
    else if (argv[index] === '--repo') options.repo = argv[++index];
    else throw new Error('Unknown argument: ' + argv[index]);
  }
  return options;
}

function batchFiles(files, maxFiles, maxBytes) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const file of files) {
    if (file.bytes > MAX_COMMIT_BYTES) throw new Error(file.remotePath + ': a single file exceeds the 2 GiB commit limit');
    if (batch.length && (batch.length >= maxFiles || bytes + file.bytes > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.bytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function createUploadPlan({ projectRoot, release, repo }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(release)) throw new Error('Invalid release id: ' + release);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) throw new Error('Invalid Hugging Face dataset repo: ' + repo);
  const root = path.join(projectRoot, '.data', 'releases', release);
  const packPlan = await readFile(path.join(root, 'pack-plan.json'), 'utf8').then(JSON.parse).catch(() => null);
  const plannedPacks = new Map((packPlan?.packs || []).map((pack) => [pack.path, pack]));
  const packManifestLines = (await readFile(path.join(root, 'packs-manifest.tsv'), 'utf8')).trimEnd().split(/\r?\n/);
  if (packManifestLines.shift() !== 'path\tbytes\tsha256') throw new Error('Invalid packs-manifest.tsv header');
  const seenRemotePaths = new Set();
  const packDefinitions = packManifestLines.filter(Boolean).map((line) => {
    const [remotePath, bytes, sha256] = line.split('\t');
    if (line.split('\t').length !== 3) throw new Error('Invalid Pack manifest row: ' + line);
    assertSafeRemotePath(remotePath, release);
    if (!/^(0|[1-9][0-9]*)$/.test(bytes) || !Number.isSafeInteger(Number(bytes))) throw new Error(remotePath + ': invalid byte size');
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(remotePath + ': invalid SHA-256');
    if (seenRemotePaths.has(remotePath)) throw new Error('Duplicate remote path: ' + remotePath);
    seenRemotePaths.add(remotePath);
    const byteCount = Number(bytes);
    if (byteCount > MAX_COMMIT_BYTES) throw new Error(remotePath + ': a single file exceeds the 2 GiB commit limit');
    return { localPath: path.join(root, ...remotePath.slice(('releases/' + release + '/').length).split('/')), remotePath, remoteDirectory: path.posix.dirname(remotePath), bytes: byteCount, sha256, kind: 'pack' };
  });
  const packs = [];
  for (const pack of packDefinitions) {
    const planned = plannedPacks.get(pack.remotePath);
    if (packPlan && (!planned || planned.bytes !== pack.bytes || planned.sha256 !== pack.sha256)) {
      throw new Error(pack.remotePath + ': pack-plan.json differs from Pack manifest');
    }
    const details = await stat(pack.localPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!details) {
      if (!planned) throw new Error(pack.remotePath + ': local Pack is missing and no pack-plan definition is available');
      packs.push({ ...pack, gitBlobSha1: null, materialized: false });
      continue;
    }
    if (details.size !== pack.bytes) throw new Error(pack.remotePath + ': local size differs from Pack manifest');
    const digests = await hashFileDigests(pack.localPath, details.size);
    if (digests.sha256 !== pack.sha256) throw new Error(pack.remotePath + ': local SHA-256 differs from Pack manifest');
    packs.push({ ...pack, gitBlobSha1: digests.gitBlobSha1, materialized: true });
  }
  const metadataPaths = ['release.json', 'catalog.json', 'manifest.tsv', 'checksums.sha256', 'manifest-index.json', 'packs-manifest.tsv'];
  for (let index = 0; index < 256; index += 1) {
    const shard = index.toString(16).padStart(2, '0');
    metadataPaths.push('manifests/manifest-' + shard + '.tsv.gz', 'manifests/checksums-' + shard + '.sha256.gz', 'catalog/genomes-' + shard + '.ndjson.gz');
  }
  const metadata = [];
  for (const relative of metadataPaths) {
    const localPath = path.join(root, relative);
    const details = await stat(localPath);
    const remotePath = 'releases/' + release + '/' + relative;
    if (details.size > MAX_COMMIT_BYTES) throw new Error(remotePath + ': a single file exceeds the 2 GiB commit limit');
    if (seenRemotePaths.has(remotePath)) throw new Error('Duplicate remote path: ' + remotePath);
    seenRemotePaths.add(remotePath);
    metadata.push({ localPath, remotePath, remoteDirectory: path.posix.dirname(remotePath), bytes: details.size, ...await hashFileDigests(localPath, details.size), kind: 'metadata' });
  }
  const byDirectory = new Map();
  for (const file of [...packs, ...metadata]) {
    if (!byDirectory.has(file.remoteDirectory)) byDirectory.set(file.remoteDirectory, []);
    byDirectory.get(file.remoteDirectory).push(file);
  }
  const batches = [];
  for (const [remoteDirectory, files] of [...byDirectory.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const packDirectory = files.some((file) => file.kind === 'pack');
    const directoryBatches = batchFiles(files, packDirectory ? MAX_PACKS : MAX_METADATA_FILES, MAX_COMMIT_BYTES);
    directoryBatches.forEach((batchFilesValue, index) => batches.push({
      id: (packDirectory ? 'packs-' : 'metadata-') + remoteDirectory.replaceAll('/', '-') + '-' + String(index + 1).padStart(3, '0'),
      remoteDirectory,
      files: batchFilesValue,
      bytes: batchFilesValue.reduce((sum, file) => sum + file.bytes, 0),
      status: 'pending',
      attempts: 0,
      commitUrl: null,
    }));
  }
  const planRoot = path.join(projectRoot, '.data', 'upload-plans');
  await mkdir(planRoot, { recursive: true });
  const output = path.join(planRoot, release + '.json');
  const previous = await readFile(output, 'utf8').then(JSON.parse).catch(() => null);
  if (previous?.schemaVersion === 1 && previous.repo === repo && previous.release === release && previous.revision === 'main') {
    const previousById = new Map(previous.batches.map((batch) => [batch.id, batch]));
    for (const batch of batches) {
      const old = previousById.get(batch.id);
      const sameFiles = old && JSON.stringify(old.files.map((file) => [file.remotePath, file.bytes, file.sha256]))
        === JSON.stringify(batch.files.map((file) => [file.remotePath, file.bytes, file.sha256]));
      if (sameFiles && old.status === 'complete' && old.commitUrl) Object.assign(batch, { status: 'complete', attempts: old.attempts, commitUrl: old.commitUrl, completedAt: old.completedAt });
      else if (sameFiles && old.status === 'failed') Object.assign(batch, { attempts: old.attempts, error: old.error });
    }
  }
  const plan = { schemaVersion: 1, repo, release, revision: 'main', createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), batches };
  await writeFile(output, JSON.stringify(plan, null, 2) + '\n');
  return { output, plan };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await createUploadPlan({ projectRoot, ...options });
  console.log(JSON.stringify({ output: result.output, batches: result.plan.batches.length }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
