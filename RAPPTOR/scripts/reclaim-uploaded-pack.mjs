import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const options = { release: '2026-08-11', shard: null, pack: null, delete: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--release') options.release = argv[++index];
    else if (argv[index] === '--shard') options.shard = argv[++index];
    else if (argv[index] === '--pack') options.pack = argv[++index];
    else if (argv[index] === '--delete') options.delete = true;
    else if (argv[index] === '--dry-run') options.delete = false;
    else throw new Error('Unknown argument: ' + argv[index]);
  }
  if (options.shard && !/^[0-9a-f]{2}$/.test(options.shard)) throw new Error('--shard must be lowercase hexadecimal 00-ff.');
  return options;
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

function isVerifiedComplete(batch) {
  const commitMatch = typeof batch?.commitUrl === 'string'
    ? batch.commitUrl.match(/^https:\/\/huggingface\.co\/datasets\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/commit\/([0-9a-f]{40,64})$/i)
    : null;
  const commitIdsValid = batch?.commitIds === undefined || (Array.isArray(batch.commitIds)
    && batch.commitIds.length > 0
    && batch.commitIds.every((commitId) => typeof commitId === 'string' && /^[0-9a-f]{40,64}$/i.test(commitId))
    && batch.commitIds.includes(commitMatch?.[1]));
  return batch?.status === 'complete'
    && typeof batch.verifiedAt === 'string'
    && batch.verifiedAt.length > 0
    && Number.isFinite(Date.parse(batch.verifiedAt))
    && Boolean(commitMatch)
    && commitIdsValid;
}

function localPackPath(releaseRoot, remotePath, release) {
  const escaped = release.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp('^releases/' + escaped + '/packs/pack-[0-9a-f]{2}-[0-9]{3}\\.bin$').test(remotePath)) {
    throw new Error('Unsafe Pack path in upload state: ' + remotePath);
  }
  const basename = path.posix.basename(remotePath);
  const resolvedRoot = path.resolve(releaseRoot, 'packs');
  const resolved = path.resolve(resolvedRoot, basename);
  if (!resolved.startsWith(resolvedRoot + path.sep)) throw new Error('Pack path escapes release packs directory.');
  return resolved;
}

/**
 * @param {{projectRoot: string, release: string, shard?: string | null, pack?: string | null, delete?: boolean}} options
 */
export async function reclaimUploadedPacks({ projectRoot, release, shard = null, pack: packSelector = null, delete: deleteFiles = false }) {
  const releaseRoot = path.join(projectRoot, '.data', 'releases', release);
  const packPlan = JSON.parse(await readFile(path.join(releaseRoot, 'pack-plan.json'), 'utf8'));
  const uploadState = JSON.parse(await readFile(path.join(projectRoot, '.data', 'upload-plans', release + '.json'), 'utf8'));
  if (packPlan.schemaVersion !== 1 || packPlan.releaseId !== release || uploadState.release !== release || !Array.isArray(uploadState.batches)) {
    throw new Error('Pack plan or upload state does not match release ' + release + '.');
  }
  const plannedByPath = new Map(packPlan.packs.map((definition) => [definition.path, definition]));
  const selected = [];
  for (const batch of uploadState.batches) {
    if (!isVerifiedComplete(batch)) continue;
    for (const file of batch.files || []) {
      if (file.kind !== 'pack') continue;
      const definition = plannedByPath.get(file.remotePath);
      if (!definition || definition.sha256 !== file.sha256 || definition.bytes !== file.bytes) {
        throw new Error(file.remotePath + ': upload state differs from immutable Pack plan');
      }
      if (shard && definition.shard !== shard) continue;
      if (packSelector && definition.path !== packSelector && path.posix.basename(definition.path) !== packSelector) continue;
      selected.push({ definition, batch });
    }
  }
  if ((shard || packSelector) && !selected.length) throw new Error('No complete, remotely verified Pack matched the requested selector.');

  const results = [];
  for (const { definition, batch } of selected) {
    const localPath = localPackPath(releaseRoot, definition.path, release);
    const details = await stat(localPath).catch(() => null);
    if (!details) {
      results.push({ path: definition.path, status: 'already-absent', verifiedAt: batch.verifiedAt });
      continue;
    }
    if (!details.isFile() || details.size !== definition.bytes || await hashFile(localPath) !== definition.sha256) {
      throw new Error(definition.path + ': local Pack does not match the verified immutable hash; refusing to delete');
    }
    if (deleteFiles) {
      await unlink(localPath);
      results.push({ path: definition.path, status: 'deleted', bytes: definition.bytes, verifiedAt: batch.verifiedAt });
    } else {
      results.push({ path: definition.path, status: 'would-delete', bytes: definition.bytes, verifiedAt: batch.verifiedAt });
    }
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const results = await reclaimUploadedPacks({ projectRoot, ...options });
  console.log(JSON.stringify({ release: options.release, mode: options.delete ? 'delete' : 'dry-run', results }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
