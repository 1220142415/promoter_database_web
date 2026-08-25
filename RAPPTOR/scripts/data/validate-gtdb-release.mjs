#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultRelease = resolve(projectRoot, '.data', 'releases', '2026-08-07');
const ACCESSION = /^GC[AF]_\d{9}\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;

function parseArgs(argv) {
  const options = { release: defaultRelease, quick: false, allowUnindexed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--release') {
      if (!argv[index + 1]) throw new Error('--release requires a path');
      options.release = resolve(argv[index += 1]);
    } else if (argument === '--quick') options.quick = true;
    else if (argument === '--allow-unindexed') options.allowUnindexed = true;
    else if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/data/validate-gtdb-release.mjs [--release PATH] [--quick] [--allow-unindexed]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function isBgzf(path) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(18);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 18 || header[0] !== 0x1f || header[1] !== 0x8b || !(header[3] & 4)) return false;
    return header.includes(Buffer.from([0x42, 0x43, 0x02, 0x00]));
  } finally {
    await handle.close();
  }
}

async function isBigWig(path) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 4 && header.readUInt32LE(0) === 0x888ffc26;
  } finally {
    await handle.close();
  }
}

function runIndexedRead(command, args, label) {
  let result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (process.platform === 'win32' && result.status === null) {
    const wslArgs = args.map((argument) => {
      const windowsPath = /^([A-Za-z]):[\\/](.*)$/.exec(argument);
      return windowsPath
        ? `/mnt/${windowsPath[1].toLowerCase()}/${windowsPath[2].replaceAll(String.fromCharCode(92), '/')}`
        : argument;
    });
    result = spawnSync('wsl.exe', ['-d', process.env.GTDB_WSL_DISTRO || 'Ubuntu', command, ...wslArgs], {
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  assert(result.status === 0, `${label}: ${command} index query failed: ${(result.stderr || '').trim()}`);
  assert((result.stdout || '').trim().length > 0, `${label}: ${command} index query returned no data`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = await readJson(join(options.release, 'catalog.json'));
  const release = await readJson(join(options.release, 'release.json'));
  const completion = await readJson(join(options.release, '.release-complete.json'));
  assert(catalog.schemaVersion === 1, 'unsupported catalog schema');
  assert(release.schemaVersion === 1, 'unsupported release schema');
  assert(completion.schemaVersion === 1 && completion.state === 'complete', 'release completion marker is missing or invalid');
  assert(completion.datasetVersion === release.datasetVersion, 'completion marker/release dataset versions differ');
  assert(completion.checksumsSha256 === await hashFile(join(options.release, 'checksums.sha256')), 'completion marker checksum does not match checksums.sha256');
  assert(Array.isArray(catalog.genomes) && catalog.genomes.length > 0, 'catalog contains no genomes');
  assert(catalog.release.datasetVersion === release.datasetVersion, 'catalog/release dataset versions differ');
  assert(catalog.release.genomeCount === catalog.genomes.length, 'catalog genome count differs from entries');
  assert(release.genomeCount === catalog.genomes.length, 'release genome count differs from catalog');
  assert(release.indexed || options.allowUnindexed, 'release is unindexed; pass --allow-unindexed only for a deliberate fallback');

  const seen = new Set();
  let promoters = 0;
  let annotated = 0;
  let incompatible = 0;
  let missing = 0;
  let circularOriginSplitFeatures = 0;
  let circularOriginSplitGenomes = 0;
  for (const genome of catalog.genomes) {
    assert(ACCESSION.test(genome.accession), `invalid accession: ${genome.accession}`);
    assert(!seen.has(genome.accession), `duplicate accession: ${genome.accession}`);
    seen.add(genome.accession);
    assert(typeof genome.taxonomy === 'string' && genome.taxonomy.split(';').length === 7, `${genome.accession}: invalid taxonomy`);
    assert(Number.isSafeInteger(genome.genomeSizeBp) && genome.genomeSizeBp > 0, `${genome.accession}: invalid genome size`);
    assert(Number.isSafeInteger(genome.contigCount) && genome.contigCount > 0, `${genome.accession}: invalid contig count`);
    assert(Number.isSafeInteger(genome.predictedPromoterCount) && genome.predictedPromoterCount >= 0, `${genome.accession}: invalid promoter count`);
    assert(genome.experimentalTssCount === 0 && genome.hasExperimentalTss === false, `${genome.accession}: predictions must not be labeled experimental TSS`);
    assert(['available', 'missing', 'incompatible'].includes(genome.annotationStatus), `${genome.accession}: invalid annotation status`);
    assert(typeof genome.defaultLocus === 'string' && genome.defaultLocus.startsWith(`${genome.primarySequence}:`), `${genome.accession}: invalid default locus`);
    const splitCount = genome.annotationCircularOriginSplitCount || 0;
    assert(Number.isSafeInteger(splitCount) && splitCount >= 0, `${genome.accession}: invalid circular-origin split count`);
    circularOriginSplitFeatures += splitCount;
    if (splitCount > 0) circularOriginSplitGenomes += 1;

    const requiredAssets = ['fasta', 'predictedPromoters', 'metadata'];
    const hasScoreTracks = Boolean(genome.assets.promoterScoresPlus || genome.assets.promoterScoresMinus);
    assert(
      Boolean(genome.assets.promoterScoresPlus) === Boolean(genome.assets.promoterScoresMinus),
      `${genome.accession}: raw score tracks must include both strands`,
    );
    if (release.rawScoreTracks) {
      assert(hasScoreTracks, `${genome.accession}: release requires raw score tracks`);
    }
    if (hasScoreTracks) requiredAssets.push('promoterScoresPlus', 'promoterScoresMinus');
    if (release.indexed) requiredAssets.push('fastaFai', 'fastaGzi', 'predictedPromotersIndex');
    if (genome.annotationStatus === 'available') {
      annotated += 1;
      requiredAssets.push('ncbiAnnotations');
      if (release.indexed) requiredAssets.push('ncbiAnnotationsIndex');
    } else {
      assert(genome.assets.ncbiAnnotations === null && genome.assets.ncbiAnnotationsIndex === null, `${genome.accession}: unavailable NCBI status has annotation assets`);
      if (genome.annotationStatus === 'incompatible') {
        incompatible += 1;
        assert(genome.annotationIssue?.reason === 'circular_origin_span', `${genome.accession}: incompatible annotation lacks a supported reason`);
      } else missing += 1;
    }
    for (const key of requiredAssets) {
      const asset = genome.assets[key];
      assert(typeof asset === 'string' && asset.startsWith(`${genome.accession}/`), `${genome.accession}: invalid ${key} path`);
      const details = await stat(join(options.release, 'objects', asset));
      assert(details.isFile() && details.size > 0, `${genome.accession}: empty ${key} asset`);
      assert(SHA256.test(genome.checksums[key]), `${genome.accession}: missing ${key} checksum`);
    }
    if (hasScoreTracks) {
      assert(await isBigWig(join(options.release, 'objects', genome.assets.promoterScoresPlus)), `${genome.accession}: plus score asset is not BigWig`);
      assert(await isBigWig(join(options.release, 'objects', genome.assets.promoterScoresMinus)), `${genome.accession}: minus score asset is not BigWig`);
    }
    if (release.indexed && !options.quick) {
      const fastaPath = join(options.release, 'objects', genome.assets.fasta);
      const promoterPath = join(options.release, 'objects', genome.assets.predictedPromoters);
      assert(await isBgzf(fastaPath), `${genome.accession}: FASTA is not BGZF`);
      assert(await isBgzf(promoterPath), `${genome.accession}: predictions are not BGZF`);
      runIndexedRead('samtools', ['faidx', fastaPath, `${genome.primarySequence}:1-1`], genome.accession);
      runIndexedRead('tabix', ['-l', promoterPath], `${genome.accession} predictions`);
      if (genome.assets.ncbiAnnotations) {
        const annotationPath = join(options.release, 'objects', genome.assets.ncbiAnnotations);
        assert(await isBgzf(annotationPath), `${genome.accession}: NCBI annotations are not BGZF`);
        runIndexedRead('tabix', ['-l', annotationPath], `${genome.accession} NCBI annotations`);
      }
    }
    promoters += genome.predictedPromoterCount;
  }
  assert(promoters === release.promoterCount, 'aggregate promoter count differs from release');
  assert(annotated === release.annotatedGenomeCount, 'annotated genome count differs from release');
  assert(annotated === release.usableAnnotationGenomeCount, 'usable annotation count differs from release');
  assert(incompatible === release.incompatibleAnnotationGenomeCount, 'incompatible annotation count differs from release');
  assert(missing === release.missingAnnotationGenomeCount, 'missing annotation count differs from release');
  assert(annotated + incompatible === release.downloadedAnnotationGenomeCount, 'downloaded annotation count differs from release');
  assert(circularOriginSplitFeatures === release.circularOriginSplitFeatureCount, 'circular-origin split feature count differs from release');
  assert(circularOriginSplitGenomes === release.circularOriginSplitGenomeCount, 'circular-origin split genome count differs from release');
  if (catalog.genomes.length === 1000) {
    assert(promoters === 23_405_141, `full release must have 23,405,141 predicted promoters, found ${promoters}`);
    assert(release.downloadedAnnotationGenomeCount === 656, `full release must record 656 downloaded NCBI annotations, found ${release.downloadedAnnotationGenomeCount}`);
    assert(annotated === 656, `full release must have 656 browser-compatible NCBI annotations, found ${annotated}`);
    assert(incompatible === 0, `full release must normalize all supported circular-origin annotations, found ${incompatible} incompatible`);
    assert(circularOriginSplitFeatures === 86, `full release must split 86 circular-origin features, found ${circularOriginSplitFeatures}`);
    assert(circularOriginSplitGenomes === 29, `full release must normalize 29 circular-origin genomes, found ${circularOriginSplitGenomes}`);
    assert(release.missingAnnotationGenomeCount === 344, 'full release must explicitly record 344 missing NCBI annotations');
  }

  const manifestLines = (await readFile(join(options.release, 'manifest.tsv'), 'utf8')).trimEnd().split(/\r?\n/);
  assert(manifestLines.shift() === 'path\tbytes\tsha256', 'invalid manifest.tsv header');
  const manifest = new Map();
  for (const line of manifestLines) {
    const [path, bytes, digest, ...extra] = line.split('\t');
    assert(path && /^\d+$/.test(bytes) && SHA256.test(digest) && !extra.length, `invalid manifest row: ${line}`);
    assert(!manifest.has(path), `duplicate manifest path: ${path}`);
    manifest.set(path, { bytes: Number(bytes), digest });
  }

  const checksumLines = (await readFile(join(options.release, 'checksums.sha256'), 'utf8')).trimEnd().split(/\r?\n/);
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert(match, `invalid checksums.sha256 row: ${line}`);
    assert(!checksums.has(match[2]), `duplicate checksum path: ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  assert(checksums.get('manifest.tsv'), 'checksums.sha256 does not cover manifest.tsv');
  for (const [path, entry] of manifest) {
    assert(checksums.get(path) === entry.digest, `${path}: manifest/checksum digest mismatch`);
    const details = await stat(join(options.release, path));
    assert(details.size === entry.bytes, `${path}: manifest byte count mismatch`);
  }
  if (!options.quick) {
    let checked = 0;
    for (const [path, expected] of checksums) {
      const actual = await hashFile(join(options.release, path));
      assert(actual === expected, `${path}: SHA-256 mismatch`);
      checked += 1;
      if (checked % 500 === 0) console.error(`Verified ${checked}/${checksums.size} checksums`);
    }
  }
  console.log(JSON.stringify({
    valid: true,
    release: release.datasetVersion,
    genomes: catalog.genomes.length,
    predictedPromoters: promoters,
    annotatedGenomes: annotated,
    downloadedNcbiAnnotations: annotated + incompatible,
    incompatibleNcbiAnnotations: incompatible,
    missingNcbiAnnotations: missing,
    circularOriginSplitFeatures,
    circularOriginSplitGenomes,
    indexed: release.indexed,
    checksums: checksums.size,
    checksumMode: options.quick ? 'skipped' : 'verified',
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
