#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALIGNMENT = 4 * 1024;
const MAX_PACK_BYTES = 1024 * 1024 * 1024;

function parseArgs(argv) {
  const options = { release: '2026-08-11', source: '2026-08-07', quick: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--release') options.release = argv[++index];
    else if (argv[index] === '--source') options.source = argv[++index];
    else if (argv[index] === '--quick') options.quick = true;
    else throw new Error('Unknown argument: ' + argv[index]);
  }
  return options;
}

function hashStream(stream) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function hashFile(file, range = null) {
  return hashStream(createReadStream(file, range ? { start: range.start, end: range.end } : undefined));
}

function gunzipBuffer(value) {
  return new Promise((resolve, reject) => gunzip(value, (error, output) => error ? reject(error) : resolve(output)));
}

function manifestRows(value) {
  const rows = new Map();
  for (const line of value.trimEnd().split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const [logicalPath, bytes, sha256] = line.split('\t');
    if (!logicalPath || !/^\d+$/.test(bytes) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid manifest row: ' + line);
    if (rows.has(logicalPath)) throw new Error('Duplicate logical manifest path: ' + logicalPath);
    rows.set(logicalPath, { bytes: Number(bytes), sha256 });
  }
  return rows;
}

function checksumRows(value) {
  const rows = new Map();
  for (const line of value.trimEnd().split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error('Invalid checksum row: ' + line);
    rows.set(match[2], match[1]);
  }
  return rows;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function packLocalPath(root, release, packPath) {
  const prefix = 'releases/' + release + '/';
  assert(packPath.startsWith(prefix), 'Pack path is outside release: ' + packPath);
  return path.join(root, ...packPath.slice(prefix.length).split('/'));
}

export async function validatePackedRelease({ projectRoot, release, source, quick = false }) {
  const root = path.join(projectRoot, '.data', 'releases', release);
  const sourceRoot = path.join(projectRoot, '.data', 'releases', source);
  const [index, catalog, releaseJson, fullManifestText, fullChecksumsText, packsManifestText] = await Promise.all([
    readFile(path.join(root, 'manifest-index.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'catalog.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'release.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'manifest.tsv'), 'utf8'),
    readFile(path.join(root, 'checksums.sha256'), 'utf8'),
    readFile(path.join(root, 'packs-manifest.tsv'), 'utf8'),
  ]);
  assert(index.schemaVersion === 2 && index.releaseId === release, 'Manifest index release/schema mismatch.');
  assert(index.sourceReleaseId === source && index.shardAlgorithm === 'sha256-prefix-2', 'Manifest index provenance/shard mismatch.');
  assert(releaseJson.layout === 'packed-v1' && releaseJson.sourceReleaseId === source, 'Release storage metadata mismatch.');
  assert(index.shards.length === 256, 'Manifest index must describe exactly 256 shards.');
  const expectedShardIds = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));
  assert(index.shards.map((shard) => shard.id).join(',') === expectedShardIds.join(','), 'Manifest index must contain each shard from 00 through ff exactly once.');

  const fullManifest = manifestRows(fullManifestText);
  const fullChecksums = checksumRows(fullChecksumsText);
  assert(fullManifest.size === fullChecksums.size, 'Full manifest/checksum row counts differ.');
  for (const [logicalPath, row] of fullManifest) assert(fullChecksums.get(logicalPath) === row.sha256, logicalPath + ': checksum differs from manifest.');

  const sourceManifest = manifestRows(await readFile(path.join(sourceRoot, 'manifest.tsv'), 'utf8'));
  const packRows = manifestRows(packsManifestText);
  const physicalByPath = new Map();
  for (const [packPath, row] of packRows) physicalByPath.set(packPath, row);
  const indexedPacks = index.shards.flatMap((shard) => shard.packs);
  const indexedPackPaths = new Set(indexedPacks.map((pack) => pack.path));
  assert(indexedPackPaths.size === indexedPacks.length && indexedPackPaths.size === physicalByPath.size, 'Pack index contains duplicate or missing physical paths.');
  for (const pack of indexedPacks) {
    const physical = physicalByPath.get(pack.path);
    assert(physical && physical.bytes === pack.bytes && physical.sha256 === pack.sha256, pack.path + ': manifest-index Pack metadata mismatch.');
  }

  const catalogByAccession = new Map(catalog.genomes.map((genome) => [genome.accession, genome]));
  assert(catalogByAccession.size === catalog.genomes.length, 'Catalog contains duplicate accessions.');
  let shardGenomeCount = 0;
  let shardLogicalCount = 0;
  const shardLogicalPaths = new Set();
  for (const shard of index.shards) {
    assert(/^[0-9a-f]{2}$/.test(shard.id), 'Invalid shard id: ' + shard.id);
    const [manifestGzip, checksumsGzip, catalogGzip] = await Promise.all([
      readFile(path.join(root, ...shard.manifestPath.split('/'))),
      readFile(path.join(root, ...shard.checksumsPath.split('/'))),
      readFile(path.join(root, ...shard.catalogPath.split('/'))),
    ]);
    const shardManifest = manifestRows(String(await gunzipBuffer(manifestGzip)));
    const shardChecksums = checksumRows(String(await gunzipBuffer(checksumsGzip)));
    const shardCatalogText = String(await gunzipBuffer(catalogGzip)).trim();
    const shardGenomes = shardCatalogText ? shardCatalogText.split(/\r?\n/).map(JSON.parse) : [];
    assert(shardManifest.size === shard.logicalFileCount, shard.id + ': logical file count mismatch.');
    assert(shardGenomes.length === shard.genomeCount, shard.id + ': genome count mismatch.');
    assert([...shardManifest.values()].reduce((sum, row) => sum + row.bytes, 0) === shard.logicalBytes, shard.id + ': logical byte count mismatch.');
    for (const [logicalPath, row] of shardManifest) {
      assert(fullManifest.get(logicalPath)?.sha256 === row.sha256, logicalPath + ': shard/full manifest mismatch.');
      assert(shardChecksums.get(logicalPath) === row.sha256, logicalPath + ': shard checksum mismatch.');
      assert(!shardLogicalPaths.has(logicalPath), logicalPath + ': appears in multiple shards.');
      shardLogicalPaths.add(logicalPath);
    }
    for (const genome of shardGenomes) {
      const fullGenome = catalogByAccession.get(genome.accession);
      assert(fullGenome && JSON.stringify(fullGenome) === JSON.stringify(genome), genome.accession + ': shard/full catalog record mismatch.');
      const actualShard = createHash('sha256').update(genome.accession, 'utf8').digest('hex').slice(0, 2);
      assert(actualShard === shard.id, genome.accession + ': catalog entry is in the wrong shard.');
    }
    shardGenomeCount += shardGenomes.length;
    shardLogicalCount += shardManifest.size;
  }
  assert(shardGenomeCount === catalog.genomes.length, 'Shard catalog genome total mismatch.');
  assert(shardLogicalCount === fullManifest.size && shardLogicalPaths.size === fullManifest.size, 'Shard/full logical manifest totals differ.');

  const packAssets = new Map();
  let storageAssets = 0;
  for (const genome of catalog.genomes) {
    const storage = genome.storage;
    assert(storage?.layout === 'packed-v1', genome.accession + ': packed storage mapping missing.');
    const expectedShard = createHash('sha256').update(genome.accession, 'utf8').digest('hex').slice(0, 2);
    assert(storage.logicalObjectPrefix === expectedShard + '/' + genome.accession, genome.accession + ': logical object prefix mismatch.');
    for (const [file, asset] of Object.entries(storage.assets)) {
      storageAssets += 1;
      assert(Number.isSafeInteger(asset.offset) && asset.offset >= 0 && asset.offset % ALIGNMENT === 0, genome.accession + '/' + file + ': offset is not 4 KiB aligned.');
      assert(Number.isSafeInteger(asset.length) && asset.length >= 0, genome.accession + '/' + file + ': invalid length.');
      assert(/^[0-9a-f]{64}$/.test(asset.sha256), genome.accession + '/' + file + ': invalid SHA-256.');
      const logicalPath = 'objects/' + storage.logicalObjectPrefix + '/' + file;
      const manifest = fullManifest.get(logicalPath);
      assert(manifest && manifest.bytes === asset.length && manifest.sha256 === asset.sha256, logicalPath + ': storage/manifest mismatch.');
      const sourcePath = 'objects/' + genome.accession + '/' + file;
      const sourceRow = sourceManifest.get(sourcePath);
      assert(sourceRow && sourceRow.bytes === asset.length && sourceRow.sha256 === asset.sha256, logicalPath + ': source release mismatch.');
      if (!packAssets.has(asset.packPath)) packAssets.set(asset.packPath, []);
      packAssets.get(asset.packPath).push({ ...asset, logicalPath, sourcePath });
    }
  }
  assert(storageAssets === fullManifest.size, 'Catalog storage asset total differs from manifest.');

  for (const [packPath, row] of physicalByPath) {
    assert(indexedPackPaths.has(packPath), packPath + ': missing from manifest index.');
    assert(row.bytes <= MAX_PACK_BYTES, packPath + ': exceeds 1 GiB hard limit.');
    const localPath = packLocalPath(root, release, packPath);
    const details = await stat(localPath);
    assert(details.size === row.bytes, packPath + ': physical byte count mismatch.');
    const assets = (packAssets.get(packPath) || []).sort((left, right) => left.offset - right.offset);
    assert(assets.length > 0, packPath + ': contains no mapped logical assets.');
    for (let indexValue = 0; indexValue < assets.length; indexValue += 1) {
      const asset = assets[indexValue];
      assert(asset.offset + asset.length <= row.bytes, asset.logicalPath + ': crosses Pack boundary.');
      if (indexValue) assert(asset.offset >= assets[indexValue - 1].offset + assets[indexValue - 1].length, packPath + ': logical assets overlap.');
      if (!quick) {
        const fragmentHash = await hashFile(localPath, { start: asset.offset, end: asset.offset + asset.length - 1 });
        assert(fragmentHash === asset.sha256, asset.logicalPath + ': Pack fragment SHA-256 mismatch.');
        const logicalDetails = await stat(path.join(root, ...asset.logicalPath.split('/')));
        assert(logicalDetails.size === asset.length, asset.logicalPath + ': logical hardlink/copy length mismatch.');
        assert(await hashFile(path.join(root, ...asset.logicalPath.split('/'))) === asset.sha256, asset.logicalPath + ': logical hardlink/copy SHA-256 mismatch.');
      }
    }
    if (!quick) assert(await hashFile(localPath) === row.sha256, packPath + ': physical Pack SHA-256 mismatch.');
  }

  const d1Root = path.join(root, 'd1');
  const d1Files = (await import('node:fs/promises')).readdir(d1Root).then((names) => names.filter((name) => /-genomes\.sql$/.test(name)));
  const inserts = (await Promise.all((await d1Files).map((name) => readFile(path.join(d1Root, name), 'utf8')))).reduce((sum, value) => sum + (value.match(/INSERT INTO genomes /g) || []).length, 0);
  assert(inserts === catalog.genomes.length, 'D1 genome INSERT total mismatch.');

  return { release, source, genomes: catalog.genomes.length, logicalFiles: fullManifest.size, packs: physicalByPath.size, bytes: [...physicalByPath.values()].reduce((sum, row) => sum + row.bytes, 0), mode: quick ? 'quick' : 'full' };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  console.log(JSON.stringify(await validatePackedRelease({ projectRoot, ...options }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
