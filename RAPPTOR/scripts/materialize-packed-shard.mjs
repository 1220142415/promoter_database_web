import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const options = { release: '2026-08-11', shard: null, pack: null, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--release') options.release = argv[++index];
    else if (argv[index] === '--shard') options.shard = argv[++index];
    else if (argv[index] === '--pack') options.pack = argv[++index];
    else if (argv[index] === '--force') options.force = true;
    else throw new Error('Unknown argument: ' + argv[index]);
  }
  if ((options.shard ? 1 : 0) + (options.pack ? 1 : 0) !== 1) throw new Error('Choose exactly one of --shard <00-ff> or --pack <pack filename/path>.');
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

function resolveWithin(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw new Error(label + ': unsafe relative path');
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, ...relative.split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) throw new Error(label + ': path escapes project root');
  return resolved;
}

function assertPackDefinition(pack, release) {
  const escaped = release.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!pack || !new RegExp('^releases/' + escaped + '/packs/pack-[0-9a-f]{2}-[0-9]{3}\\.bin$').test(pack.path)) {
    throw new Error('Invalid Pack path in plan.');
  }
  if (!/^[0-9a-f]{2}$/.test(pack.shard) || !Number.isSafeInteger(pack.bytes) || pack.bytes < 0 || !/^[0-9a-f]{64}$/.test(pack.sha256)) {
    throw new Error(pack.path + ': invalid Pack metadata');
  }
  let end = 0;
  for (const entry of pack.entries || []) {
    if (!Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.bytes) || entry.offset < end || entry.bytes < 0 || entry.offset % 4096 !== 0) {
      throw new Error(pack.path + ': invalid or overlapping entry offsets');
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(pack.path + ': invalid entry SHA-256');
    end = entry.offset + entry.bytes;
  }
  if (end !== pack.bytes) throw new Error(pack.path + ': entries do not match planned Pack length');
}

async function appendEntry(handle, source, entry) {
  const details = await stat(source);
  if (details.size !== entry.bytes) throw new Error(source + ': source size differs from Pack plan');
  const hash = createHash('sha256');
  let position = entry.offset;
  for await (const chunk of createReadStream(source)) {
    hash.update(chunk);
    await handle.write(chunk, 0, chunk.length, position);
    position += chunk.length;
  }
  if (hash.digest('hex') !== entry.sha256) throw new Error(source + ': source SHA-256 differs from Pack plan');
}

/**
 * @param {{projectRoot: string, release: string, shard?: string | null, pack?: string | null, force?: boolean}} options
 */
export async function materializePackedSelection({ projectRoot, release, shard = null, pack: packSelector = null, force = false }) {
  const releaseRoot = path.join(projectRoot, '.data', 'releases', release);
  const plan = JSON.parse(await readFile(path.join(releaseRoot, 'pack-plan.json'), 'utf8'));
  if (plan.schemaVersion !== 1 || plan.releaseId !== release || !Array.isArray(plan.packs)) throw new Error('Pack plan does not match release ' + release + '.');
  const selected = plan.packs.filter((pack) => shard
    ? pack.shard === shard
    : pack.path === packSelector || path.posix.basename(pack.path) === packSelector);
  if (!selected.length) throw new Error('No Pack matched the requested selector.');
  if (packSelector && selected.length !== 1) throw new Error('Pack selector is ambiguous.');

  const results = [];
  for (const definition of selected) {
    assertPackDefinition(definition, release);
    const releaseRelative = definition.path.slice(('releases/' + release + '/').length);
    const destination = resolveWithin(releaseRoot, releaseRelative, definition.path);
    const existing = await stat(destination).catch(() => null);
    if (existing) {
      const matches = existing.isFile() && existing.size === definition.bytes && await hashFile(destination) === definition.sha256;
      if (matches) {
        results.push({ path: definition.path, localPath: destination, status: 'verified-existing' });
        continue;
      }
      if (!force) throw new Error(definition.path + ': existing local Pack differs; use --force to replace it.');
      await rm(destination, { force: true });
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = destination + '.partial-' + process.pid;
    await rm(temporary, { force: true });
    const handle = await open(temporary, 'wx');
    try {
      for (const entry of definition.entries) {
        const source = resolveWithin(projectRoot, entry.sourcePath, definition.path + ' source');
        await appendEntry(handle, source, entry);
      }
      await handle.truncate(definition.bytes);
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    if (await hashFile(temporary) !== definition.sha256) {
      await rm(temporary, { force: true });
      throw new Error(definition.path + ': materialized Pack SHA-256 differs from plan');
    }
    await rename(temporary, destination);
    results.push({ path: definition.path, localPath: destination, status: 'materialized' });
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const results = await materializePackedSelection({ projectRoot, ...options });
  console.log(JSON.stringify({ release: options.release, results }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
