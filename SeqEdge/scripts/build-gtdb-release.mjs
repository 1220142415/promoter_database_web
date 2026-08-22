import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultReleaseDate = '2026-08-07';
const defaultArchive = resolve(projectRoot, '..', 'gtdb_selected_data_20260807.tar.gz');
const defaultOutput = resolve(projectRoot, '.data', 'releases', defaultReleaseDate);
const defaultAppCatalog = resolve(projectRoot, 'src', 'generated', 'release-catalog.json');
const ACCESSION = /^GC[AF]_\d{9}\.\d+$/;
const TAXONOMY_PREFIXES = ['d', 'p', 'c', 'o', 'f', 'g', 's'];

function parseArgs(argv) {
  const options = {
    archive: defaultArchive,
    output: defaultOutput,
    releaseDate: defaultReleaseDate,
    appCatalog: defaultAppCatalog,
    force: false,
    preflightOnly: false,
    allowUnindexed: false,
    toolMode: 'auto',
    wslDistro: process.env.GTDB_WSL_DISTRO || 'Ubuntu',
    scoreRoot: null,
    limit: null,
    publishStage: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === '--archive') options.archive = resolve(value());
    else if (argument === '--output') options.output = resolve(value());
    else if (argument === '--release-date') options.releaseDate = value();
    else if (argument === '--app-catalog') options.appCatalog = resolve(value());
    else if (argument === '--no-app-catalog') options.appCatalog = null;
    else if (argument === '--force') options.force = true;
    else if (argument === '--preflight') options.preflightOnly = true;
    else if (argument === '--allow-unindexed') options.allowUnindexed = true;
    else if (argument === '--tool-mode') options.toolMode = value();
    else if (argument === '--wsl-distro') options.wslDistro = value();
    else if (argument === '--score-root') options.scoreRoot = resolve(value());
    else if (argument === '--limit') options.limit = Number(value());
    else if (argument === '--publish-stage') options.publishStage = resolve(value());
    else if (argument === '--help' || argument === '-h') {
      console.log(`Usage: node scripts/build-gtdb-release.mjs [options]\n\n` +
        `  --archive PATH          Source tar.gz (default: ../gtdb_selected_data_20260807.tar.gz)\n` +
        `  --output PATH           Release directory (default: .data/releases/2026-08-07)\n` +
        `  --release-date DATE     Dataset version date\n` +
        `  --app-catalog PATH      Small catalog copy used by the app\n` +
        `  --no-app-catalog        Do not write the app catalog copy\n` +
        `  --tool-mode MODE        auto, native, wsl, or none\n` +
        `  --wsl-distro NAME       WSL distribution (default: Ubuntu)\n` +
        `  --score-root PATH       Per-genome raw score Parquet directory (optional)\n` +
        `  --allow-unindexed       Build a non-publishable gzip-only fallback\n` +
        `  --preflight             Inspect inputs/tools without building\n` +
        `  --limit N               Build the first N accessions (smoke testing only)\n` +
        `  --publish-stage PATH    Publish a preserved, completed stage without rebuilding\n` +
        `  --force                 Replace an existing release after a successful build`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.releaseDate)) throw new Error('release date must be YYYY-MM-DD');
  if (!['auto', 'native', 'wsl', 'none'].includes(options.toolMode)) throw new Error('tool mode must be auto, native, wsl, or none');
  if (options.limit !== null && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error('--limit must be a positive integer');
  return options;
}

function commandAvailable(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

function wslToolsAvailable(distro) {
  if (process.platform !== 'win32') return false;
  const result = spawnSync(
    'wsl.exe',
    ['-d', distro, 'bash', '-lc', 'command -v bgzip >/dev/null && command -v tabix >/dev/null && command -v samtools >/dev/null && command -v gzip >/dev/null'],
    { stdio: 'ignore', windowsHide: true },
  );
  return result.status === 0;
}

function detectToolchain(options) {
  const native = ['bgzip', 'tabix', 'samtools', 'gzip', 'bash'].every((tool) => commandAvailable(tool));
  const wsl = wslToolsAvailable(options.wslDistro);
  let selected = null;
  if (options.toolMode === 'native') selected = native ? 'native' : null;
  else if (options.toolMode === 'wsl') selected = wsl ? 'wsl' : null;
  else if (options.toolMode === 'auto') selected = native ? 'native' : wsl ? 'wsl' : null;
  return { native, wsl, selected };
}

function detectScoreRuntime(toolchain, options) {
  const probe = ['-c', 'import pyarrow, pyBigWig'];
  if (toolchain.selected === 'native') {
    return spawnSync('python3', probe, { stdio: 'ignore', windowsHide: true }).status === 0;
  }
  if (toolchain.selected === 'wsl') {
    return spawnSync(
      'wsl.exe',
      ['-d', options.wslDistro, 'python3', ...probe],
      { stdio: 'ignore', windowsHide: true },
    ).status === 0;
  }
  return null;
}

function run(command, args, settings = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...settings });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseTaxonomy(value, accession) {
  const ranks = value.split(';');
  if (ranks.length !== 7) throw new Error(`${accession}: expected seven GTDB taxonomy ranks`);
  const names = ranks.map((rank, index) => {
    const prefix = `${TAXONOMY_PREFIXES[index]}__`;
    if (!rank.startsWith(prefix)) throw new Error(`${accession}: invalid taxonomy rank ${rank}`);
    return rank.slice(prefix.length) || null;
  });
  return {
    domain: names[0],
    phylum: names[1],
    className: names[2],
    order: names[3],
    family: names[4],
    genus: names[5],
    species: names[6],
    raw: value,
  };
}

async function loadTaxonomy(path) {
  const result = new Map();
  const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    const [accession, taxonomy, ...extra] = line.split('\t');
    if (!ACCESSION.test(accession) || !taxonomy || extra.length) throw new Error(`invalid taxonomy row: ${line.slice(0, 120)}`);
    if (result.has(accession)) throw new Error(`duplicate taxonomy accession: ${accession}`);
    result.set(accession, parseTaxonomy(taxonomy, accession));
  }
  return result;
}

async function parseFasta(path) {
  const gunzip = createGunzip();
  const input = createInterface({ input: createReadStream(path).pipe(gunzip), crlfDelay: Infinity });
  const sequences = [];
  let current = null;
  let genomeSizeBp = 0;
  let gcBases = 0;
  for await (const line of input) {
    if (line.startsWith('>')) {
      const name = line.slice(1).trim().split(/\s+/, 1)[0];
      if (!name) throw new Error(`${path}: empty FASTA sequence name`);
      if (sequences.some((sequence) => sequence.name === name)) throw new Error(`${path}: duplicate FASTA sequence name ${name}`);
      current = { name, length: 0 };
      sequences.push(current);
      continue;
    }
    if (!current && line.trim()) throw new Error(`${path}: sequence data precedes FASTA header`);
    const sequence = line.trim().toUpperCase();
    if (!sequence) continue;
    if (!/^[A-Z.*-]+$/.test(sequence)) throw new Error(`${path}: invalid FASTA sequence characters`);
    current.length += sequence.length;
    genomeSizeBp += sequence.length;
    gcBases += (sequence.match(/[GC]/g) || []).length;
  }
  if (!sequences.length || !genomeSizeBp) throw new Error(`${path}: empty FASTA`);
  if (sequences.some((sequence) => sequence.length === 0)) throw new Error(`${path}: FASTA contains an empty sequence`);
  return {
    genomeSizeBp,
    gcContent: Number(((gcBases / genomeSizeBp) * 100).toFixed(4)),
    contigCount: sequences.length,
    primarySequence: sequences[0].name,
    primarySequenceLength: sequences[0].length,
    sequenceLengths: new Map(sequences.map((sequence) => [sequence.name, sequence.length])),
  };
}

function compareGff(a, b) {
  if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
  return a.start - b.start || a.end - b.end || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0);
}

class NcbiAnnotationCompatibilityError extends Error {
  constructor(source, issue) {
    super(`${source}: NCBI annotation contains a circular-origin feature that cannot be indexed without biological normalization (${issue.sequence}:${issue.start}-${issue.end}, ${issue.type})`);
    this.name = 'NcbiAnnotationCompatibilityError';
    this.issue = issue;
  }
}

function parseGffAttributes(value) {
  return Object.fromEntries(value.split(';').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('=');
    return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function updateGffCoordinates(feature, start, end, phase = feature.fields[7]) {
  const fields = [...feature.fields];
  fields[3] = String(start);
  fields[4] = String(end);
  fields[7] = phase;
  return { ...feature, start, end, line: fields.join('\t'), fields };
}

function nextCdsPhase(phase, segmentLength) {
  return ((phase - segmentLength) % 3 + 3) % 3;
}

/**
 * @param {string} source
 * @param {string} destination
 * @param {{ expectedType?: string | null, sequences?: Map<string, number> | null }} [settings]
 */
async function normalizeGff(source, destination, { expectedType = null, sequences = null } = {}) {
  const compressed = source.endsWith('.gz');
  const sourceStream = compressed ? createReadStream(source).pipe(createGunzip()) : createReadStream(source);
  const input = createInterface({ input: sourceStream, crlfDelay: Infinity });
  const headers = [];
  const features = [];
  const circularSequences = new Set();
  const sequenceRegions = new Map();
  let fastaSection = false;
  let sawGffVersion = false;
  for await (const line of input) {
    if (!line.trim()) continue;
    if (line === '##FASTA') {
      fastaSection = true;
      continue;
    }
    if (fastaSection) continue;
    if (line.startsWith('#')) {
      if (line === '##gff-version 3') sawGffVersion = true;
      else if (line.startsWith('##sequence-region')) {
        const match = /^##sequence-region\s+(\S+)\s+(\d+)\s+(\d+)$/.exec(line);
        if (!match) throw new Error(`${source}: invalid ##sequence-region directive`);
        const region = { start: Number(match[2]), end: Number(match[3]) };
        const previous = sequenceRegions.get(match[1]);
        if (previous && (previous.start !== region.start || previous.end !== region.end)) {
          throw new Error(`${source}: conflicting ##sequence-region directives for ${match[1]}`);
        }
        sequenceRegions.set(match[1], region);
      } else headers.push(line);
      continue;
    }
    const fields = line.split('\t');
    if (fields.length !== 9) throw new Error(`${source}: GFF3 row does not have nine fields`);
    const start = Number(fields[3]);
    const end = Number(fields[4]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error(`${source}: invalid GFF3 coordinates ${fields[0]}:${fields[3]}-${fields[4]}`);
    }
    if (expectedType && fields[2] !== expectedType) throw new Error(`${source}: expected ${expectedType}, found ${fields[2]}`);
    if (!['+', '-', '.', '?'].includes(fields[6])) throw new Error(`${source}: invalid GFF3 strand ${fields[6]}`);
    if (fields[5] !== '.' && !Number.isFinite(Number(fields[5]))) throw new Error(`${source}: invalid GFF3 score ${fields[5]}`);
    if (!['.', '0', '1', '2'].includes(fields[7])) throw new Error(`${source}: invalid GFF3 phase ${fields[7]}`);
    if (fields[2] === 'CDS' && !['0', '1', '2'].includes(fields[7])) throw new Error(`${source}: CDS phase must be 0, 1, or 2`);
    const attributes = parseGffAttributes(fields[8]);
    if (fields[2] === 'region' && attributes.Is_circular === 'true') circularSequences.add(fields[0]);
    if (expectedType === 'promoter_peak') {
      const score = Number(fields[5]);
      if (!Number.isFinite(score) || score <= 0.9 || score > 1) throw new Error(`${source}: promoter score is outside (0.9, 1]`);
      if (start !== end) throw new Error(`${source}: promoter_peak must be a point feature`);
      if (!['+', '-'].includes(fields[6])) throw new Error(`${source}: promoter strand must be + or -`);
      if (!attributes.ID) throw new Error(`${source}: promoter_peak is missing ID`);
      const attributeScore = Number(attributes.prediction_score);
      if (!Number.isFinite(attributeScore) || Math.abs(attributeScore - score) > 1e-9) {
        throw new Error(`${source}: prediction_score does not match the GFF3 score`);
      }
    }
    features.push({ sequence: fields[0], start, end, type: fields[2], line, fields, attributes });
  }
  if (!sawGffVersion) throw new Error(`${source}: missing ##gff-version 3 directive`);
  let circularOriginSplitCount = 0;
  if (sequences) {
    const idCounts = new Map();
    const featuresById = new Map();
    for (const feature of features) {
      const id = feature.attributes.ID;
      if (!id) continue;
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
      if (!featuresById.has(id)) featuresById.set(id, feature);
    }
    const normalized = [];
    for (const feature of features) {
      const sequenceLength = sequences.get(feature.sequence);
      if (!sequenceLength) throw new Error(`${source}: GFF3 sequence ${feature.sequence} is absent from FASTA`);
      if (feature.end <= sequenceLength) {
        normalized.push(feature);
        continue;
      }
      const circularOriginSpan = !expectedType
        && circularSequences.has(feature.sequence)
        && ['gene', 'CDS', 'pseudogene'].includes(feature.type)
        && feature.start <= sequenceLength
        && feature.end <= sequenceLength * 2
        && feature.end - feature.start + 1 <= sequenceLength;
      if (!circularOriginSpan) throw new Error(`${source}: GFF3 coordinate exceeds FASTA sequence ${feature.sequence}`);

      const issue = {
          reason: 'circular_origin_span',
          sequence: feature.sequence,
          sequenceLength,
          start: feature.start,
          end: feature.end,
          type: feature.type,
      };
      const sequenceRegion = sequenceRegions.get(feature.sequence);
      const id = feature.attributes.ID;
      const unsafeCoordinateAttribute = ['Target', 'Gap', 'transl_except', 'anticodon'].find((key) => feature.attributes[key] !== undefined);
      if (!sequenceRegion || sequenceRegion.start !== 1 || sequenceRegion.end !== sequenceLength) {
        throw new NcbiAnnotationCompatibilityError(source, { ...issue, reason: 'circular_sequence_region_mismatch' });
      }
      if (!id || idCounts.get(id) !== 1 || unsafeCoordinateAttribute) {
        throw new NcbiAnnotationCompatibilityError(source, { ...issue, reason: unsafeCoordinateAttribute ? `unsupported_${unsafeCoordinateAttribute}` : 'ambiguous_circular_feature_id' });
      }
      if (feature.type === 'CDS') {
        const parents = (feature.attributes.Parent || '').split(',').filter(Boolean);
        const parent = parents.length === 1 ? featuresById.get(parents[0]) : null;
        if (!parent || parent.sequence !== feature.sequence || parent.fields[6] !== feature.fields[6]
          || parent.end <= sequenceLength || !['gene', 'pseudogene'].includes(parent.type)) {
          throw new NcbiAnnotationCompatibilityError(source, { ...issue, reason: 'unresolved_circular_parent' });
        }
      }

      const headEnd = feature.end - sequenceLength;
      const tailLength = sequenceLength - feature.start + 1;
      const headLength = headEnd;
      let headPhase = feature.fields[7];
      let tailPhase = feature.fields[7];
      if (feature.type === 'CDS') {
        const phase = Number(feature.fields[7]);
        if (feature.fields[6] === '+') headPhase = String(nextCdsPhase(phase, tailLength));
        else if (feature.fields[6] === '-') tailPhase = String(nextCdsPhase(phase, headLength));
        else throw new NcbiAnnotationCompatibilityError(source, { ...issue, reason: 'invalid_circular_cds_strand' });
      }
      normalized.push(updateGffCoordinates(feature, 1, headEnd, headPhase));
      normalized.push(updateGffCoordinates(feature, feature.start, sequenceLength, tailPhase));
      circularOriginSplitCount += 1;
    }
    features.splice(0, features.length, ...normalized);
  }
  features.sort(compareGff);
  const output = createWriteStream(destination);
  const gzip = createGzip({ level: 9, mtime: 0 });
  gzip.pipe(output);
  if (!gzip.write('##gff-version 3\n')) await once(gzip, 'drain');
  for (const header of headers.sort()) {
    if (!gzip.write(`${header}\n`)) await once(gzip, 'drain');
  }
  for (const feature of features) {
    if (!gzip.write(`${feature.line}\n`)) await once(gzip, 'drain');
  }
  gzip.end();
  await new Promise((resolvePromise, rejectPromise) => {
    output.once('finish', resolvePromise);
    output.once('error', rejectPromise);
    gzip.once('error', rejectPromise);
  });
  return {
    featureCount: features.length - circularOriginSplitCount,
    normalizedFeatureCount: features.length,
    circularOriginSplitCount,
    firstFeature: features[0] || null,
  };
}

async function extractArchive(archive, target) {
  await mkdir(target, { recursive: true });
  await run('tar', ['-xzf', archive, '-C', target]);
}

function toWslPath(path, distro) {
  const windowsPath = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (windowsPath) return `/mnt/${windowsPath[1].toLowerCase()}/${windowsPath[2].replaceAll(String.fromCharCode(92), '/')}`;
  const result = spawnSync('wsl.exe', ['-d', distro, 'wslpath', '-a', '-u', path], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`could not translate path for WSL: ${path}`);
  return result.stdout.trim();
}

async function preprocessRelease(stage, toolchain, options, scoreRoot = null) {
  const helper = resolve(projectRoot, 'scripts', 'lib', 'preprocess-gtdb-release.sh');
  const converter = resolve(projectRoot, 'scripts', 'convert-promoter-scores.py');
  if (toolchain.selected === 'native') {
    const nativeArgs = [stage];
    if (scoreRoot) nativeArgs.push(converter, scoreRoot);
    await run('bash', [helper, ...nativeArgs]);
  } else if (toolchain.selected === 'wsl') {
    const helperArgs = [toWslPath(stage, options.wslDistro)];
    if (scoreRoot) helperArgs.push(toWslPath(converter, options.wslDistro), toWslPath(scoreRoot, options.wslDistro));
    await run('wsl.exe', [
      '-d',
      options.wslDistro,
      'bash',
      toWslPath(helper, options.wslDistro),
      ...helperArgs,
    ]);
  }
}

function assetPaths(accession, hasAnnotation, indexed, scoreIndexed = false) {
  const prefix = accession;
  return {
    fasta: `${prefix}/reference.fa.gz`,
    fastaFai: indexed ? `${prefix}/reference.fa.gz.fai` : null,
    fastaGzi: indexed ? `${prefix}/reference.fa.gz.gzi` : null,
    predictedPromoters: `${prefix}/predicted-promoters.gff3.gz`,
    predictedPromotersIndex: indexed ? `${prefix}/predicted-promoters.gff3.gz.tbi` : null,
    promoterScoresPlus: scoreIndexed ? `${prefix}/promoter-scores.plus.bw` : null,
    promoterScoresMinus: scoreIndexed ? `${prefix}/promoter-scores.minus.bw` : null,
    ncbiAnnotations: hasAnnotation ? `${prefix}/ncbi-annotations.gff3.gz` : null,
    ncbiAnnotationsIndex: hasAnnotation && indexed ? `${prefix}/ncbi-annotations.gff3.gz.tbi` : null,
    metadata: `${prefix}/metadata.json`,
  };
}

async function validatePreservedStage(stage) {
  const catalog = JSON.parse(await readFile(join(stage, 'catalog.json'), 'utf8'));
  const release = JSON.parse(await readFile(join(stage, 'release.json'), 'utf8'));
  if (catalog.schemaVersion !== 1 || release.schemaVersion !== 1) throw new Error('publish stage has an unsupported schema');
  if (!Array.isArray(catalog.genomes) || catalog.genomes.length !== release.genomeCount) throw new Error('publish stage genome counts do not match');
  if (!release.indexed || !release.publishable) throw new Error('preserved stage is not indexed and publishable');

  const checksumLines = (await readFile(join(stage, 'checksums.sha256'), 'utf8')).trimEnd().split(/\r?\n/);
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`invalid preserved-stage checksum row: ${line}`);
    const asset = resolve(stage, match[2]);
    const assetRelative = relative(resolve(stage), asset);
    if (!assetRelative || assetRelative.startsWith('..') || isAbsolute(assetRelative)) throw new Error(`unsafe preserved-stage path: ${match[2]}`);
    if (!(await exists(asset))) throw new Error(`preserved-stage asset is missing: ${match[2]}`);
    if (await hashFile(asset) !== match[1]) throw new Error(`preserved-stage checksum mismatch: ${match[2]}`);
  }
  return { catalog, release };
}

async function replaceRelease(stage, output, force) {
  const dataRoot = resolve(projectRoot, '.data');
  const outputRelative = relative(dataRoot, resolve(output));
  if (!outputRelative || outputRelative.startsWith('..') || isAbsolute(outputRelative)) {
    throw new Error(`release output must be a child of ${dataRoot}`);
  }
  if (resolve(stage) === resolve(output)) throw new Error('publish stage and release output must be different directories');
  for (const required of ['catalog.json', 'release.json', 'manifest.tsv', 'checksums.sha256', 'objects']) {
    if (!(await exists(join(stage, required)))) throw new Error(`publish stage is incomplete: missing ${required}`);
  }
  const alreadyExists = await exists(output);
  if (alreadyExists && !force) throw new Error(`release already exists: ${output} (use --force to replace it)`);
  const outputParent = dirname(output);
  await mkdir(outputParent, { recursive: true });
  const candidate = join(outputParent, `.${optionsSafeBasename(output)}.publish-${process.pid}`);
  await rm(candidate, { recursive: true, force: true });
  console.error(`Copying completed stage to publish candidate ${candidate}`);
  await cp(stage, candidate, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });

  if (alreadyExists) await rm(output, { recursive: true, force: true });
  try {
    await rename(candidate, output);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null;
    if (!['EACCES', 'EPERM', 'EXDEV'].includes(code)) throw error;
    console.error(`Directory rename failed with ${code}; copying the complete candidate directly to ${output}`);
    await rm(output, { recursive: true, force: true });
    await cp(candidate, output, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    await rm(candidate, { recursive: true, force: true });
  }

  const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
  await writeJson(join(output, '.release-complete.json'), {
    schemaVersion: 1,
    state: 'complete',
    datasetVersion: release.datasetVersion,
    generatedAt: release.generatedAt,
    checksumsSha256: await hashFile(join(output, 'checksums.sha256')),
  });
}

function optionsSafeBasename(path) {
  const parts = resolve(path).split(/[\\/]/);
  return parts[parts.length - 1].replace(/[^A-Za-z0-9._-]/g, '_');
}

async function publishPreservedStage(options) {
  const stage = options.publishStage;
  if (!(await exists(stage))) throw new Error(`preserved publish stage does not exist: ${stage}`);
  const { release } = await validatePreservedStage(stage);
  try {
    await replaceRelease(stage, options.output, options.force);
  } catch (error) {
    console.error(`Publish failed. The completed stage remains at ${stage}`);
    throw error;
  }
  if (options.appCatalog && release.indexed && release.publishable) {
    await mkdir(dirname(options.appCatalog), { recursive: true });
    await copyFile(join(options.output, 'catalog.json'), options.appCatalog);
  }
  console.error(`Published preserved stage to ${options.output}`);
}

async function build(options, toolchain) {
  if (!toolchain.selected && !options.allowUnindexed) {
    throw new Error('bgzip, tabix, samtools, and gzip are required; install them or explicitly use --allow-unindexed for a non-publishable fallback');
  }
  const dataRoot = resolve(projectRoot, '.data');
  const workRoot = resolve(dataRoot, 'work');
  await mkdir(workRoot, { recursive: true });
  const temporary = await mkdtemp(join(workRoot, 'gtdb-release-'));
  const extracted = join(temporary, 'source');
  const stage = join(temporary, 'release');
  const objectsRoot = join(stage, 'objects');
  await mkdir(objectsRoot, { recursive: true });
  let stageComplete = false;
  let published = false;

  try {
    console.error(`Extracting ${options.archive}`);
    await extractArchive(options.archive, extracted);
    const scoreRoot = options.scoreRoot || join(extracted, 'prediction_scores_step_50');
    const scoreEnabled = await exists(scoreRoot);
    if (options.scoreRoot && !scoreEnabled) throw new Error(`score root does not exist: ${scoreRoot}`);
    if (scoreEnabled) {
      console.error(`Raw score Parquet directory: ${scoreRoot}`);
      if (toolchain.selected && !detectScoreRuntime(toolchain, options)) {
        throw new Error('raw score conversion requires Python 3 with pyarrow and pyBigWig in the selected toolchain');
      }
    }
    const taxonomyPath = join(extracted, 'filtered_genome_tax_bac', 'genome_tax_bac.filtered.tsv');
    const taxonomy = await loadTaxonomy(taxonomyPath);
    const sourceFastas = (await readdir(join(extracted, 'genomes'))).filter((name) => name.endsWith('_genomic.fna.gz'));
    const sourcePredictions = (await readdir(join(extracted, 'prediction_gff3_gt_0.9'))).filter((name) => name.endsWith('.peaks_gt_0.9.gff3'));
    const sourceAnnotations = (await readdir(join(extracted, 'ncbi_gff3'))).filter((name) => name.endsWith('.genomic.gff3.gz'));
    if (sourceFastas.length !== taxonomy.size || sourcePredictions.length !== taxonomy.size) {
      throw new Error(`source inventory mismatch: ${taxonomy.size} taxonomy, ${sourceFastas.length} FASTA, ${sourcePredictions.length} prediction files`);
    }
    let accessions = [...taxonomy.keys()].sort();
    if (options.limit !== null) accessions = accessions.slice(0, options.limit);
    if (!accessions.length) throw new Error('taxonomy contains no genomes');

    const downloadStatus = new Map();
    const manifestInput = createInterface({
      input: createReadStream(join(extracted, 'ncbi_gff3', 'download_manifest.tsv')),
      crlfDelay: Infinity,
    });
    let manifestHeader = true;
    for await (const line of manifestInput) {
      if (manifestHeader) {
        manifestHeader = false;
        if (line !== 'accession\tstatus\tfile\tcompressed_bytes') throw new Error('unexpected NCBI download manifest header');
        continue;
      }
      const [accession, statusValue, file, bytes] = line.split('\t');
      if (!ACCESSION.test(accession) || !['downloaded', 'no_ncbi_gff3'].includes(statusValue)) throw new Error(`invalid NCBI manifest row: ${line}`);
      downloadStatus.set(accession, { status: statusValue, file: file || null, compressedBytes: Number(bytes) });
    }
    if (downloadStatus.size !== taxonomy.size) throw new Error(`NCBI manifest has ${downloadStatus.size} rows for ${taxonomy.size} genomes`);
    const downloadedAccessions = new Set([...downloadStatus]
      .filter(([, entry]) => entry.status === 'downloaded')
      .map(([accession]) => accession));
    const missingAccessions = new Set([...downloadStatus]
      .filter(([, entry]) => entry.status === 'no_ncbi_gff3')
      .map(([accession]) => accession));
    const explicitMissing = new Set((await readFile(join(extracted, 'ncbi_gff3', 'no_ncbi_gff3.txt'), 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean));
    if (sourceAnnotations.length !== downloadedAccessions.size) {
      throw new Error(`NCBI inventory mismatch: ${downloadedAccessions.size} downloaded statuses, ${sourceAnnotations.length} annotation files`);
    }
    if (explicitMissing.size !== missingAccessions.size || [...missingAccessions].some((accession) => !explicitMissing.has(accession))) {
      throw new Error('no_ncbi_gff3.txt does not match the explicit missing statuses in download_manifest.tsv');
    }
    for (const accession of taxonomy.keys()) {
      if (!downloadStatus.has(accession)) throw new Error(`${accession}: absent from NCBI download manifest`);
    }

    const records = [];
    for (let index = 0; index < accessions.length; index += 1) {
      const accession = accessions[index];
      const objectRoot = join(objectsRoot, accession);
      await mkdir(objectRoot);
      const sourceFasta = join(extracted, 'genomes', `${accession}_genomic.fna.gz`);
      const sourcePrediction = join(extracted, 'prediction_gff3_gt_0.9', `${accession}.peaks_gt_0.9.gff3`);
      if (!(await exists(sourceFasta)) || !(await exists(sourcePrediction))) throw new Error(`${accession}: missing FASTA or prediction file`);

      const fasta = await parseFasta(sourceFasta);
      await copyFile(sourceFasta, join(objectRoot, 'reference.fa.gz'));
      const predictions = await normalizeGff(sourcePrediction, join(objectRoot, 'predicted-promoters.gff3.gz'), {
        expectedType: 'promoter_peak',
        sequences: fasta.sequenceLengths,
      });

      const ncbi = downloadStatus.get(accession);
      if (!ncbi) throw new Error(`${accession}: missing from NCBI download manifest`);
      let annotationFeatureCount = 0;
      let annotationCircularOriginSplitCount = 0;
      let annotationStatus = ncbi.status === 'downloaded' ? 'available' : 'missing';
      let annotationIssue = null;
      if (ncbi.status === 'downloaded') {
        const sourceNcbi = join(extracted, 'ncbi_gff3', ncbi.file);
        if (!(await exists(sourceNcbi))) throw new Error(`${accession}: NCBI manifest points to a missing file`);
        try {
          const annotations = await normalizeGff(sourceNcbi, join(objectRoot, 'ncbi-annotations.gff3.gz'), {
            sequences: fasta.sequenceLengths,
          });
          annotationFeatureCount = annotations.featureCount;
          annotationCircularOriginSplitCount = annotations.circularOriginSplitCount;
        } catch (error) {
          if (!(error instanceof NcbiAnnotationCompatibilityError)) throw error;
          annotationStatus = 'incompatible';
          annotationIssue = error.issue;
          await rm(join(objectRoot, 'ncbi-annotations.gff3.gz'), { force: true });
          console.error(`${accession}: quarantined NCBI annotation (${error.issue.reason})`);
        }
      }

      const taxonomyEntry = taxonomy.get(accession);
      records.push({
        accession,
        taxonomy: taxonomyEntry,
        ...fasta,
        sequenceLengths: undefined,
        promoterCount: predictions.featureCount,
        annotationStatus,
        annotationFeatureCount,
        annotationCircularOriginSplitCount,
        annotationIssue,
      });
      if ((index + 1) % 25 === 0 || index + 1 === accessions.length) console.error(`Parsed ${index + 1}/${accessions.length} genomes`);
    }

    const indexed = Boolean(toolchain.selected);
    if (indexed) {
      console.error(`Preprocessing assets with ${toolchain.selected} bgzip/tabix/samtools`);
      await preprocessRelease(stage, toolchain, options, scoreEnabled ? scoreRoot : null);
    } else {
      console.error('WARNING: building a gzip-only, non-publishable fallback without random-access indexes');
      if (scoreEnabled) console.error('WARNING: raw score tracks are omitted because the release is not indexed');
    }

    const genomes = [];
    const knownHashes = new Map();
    let totalPromoters = 0;
    let annotatedGenomes = 0;
    let incompatibleAnnotationGenomes = 0;
    let missingAnnotationGenomes = 0;
    let circularOriginSplitFeatures = 0;
    let circularOriginSplitGenomes = 0;
    for (const record of records) {
      const { accession, taxonomy: tax } = record;
      const hasAnnotation = record.annotationStatus === 'available';
      const scoreIndexed = indexed && scoreEnabled;
      const assets = assetPaths(accession, hasAnnotation, indexed, scoreIndexed);
      const checksums = {};
      for (const [key, asset] of Object.entries(assets)) {
        if (!asset || key === 'metadata') continue;
        const releasePath = `objects/${asset}`;
        const digest = await hashFile(join(stage, releasePath));
        checksums[key] = digest;
        knownHashes.set(releasePath, digest);
      }
      const defaultLocus = `${record.primarySequence}:1-${Math.min(10000, record.primarySequenceLength)}`;
      const genome = {
        accession,
        organismName: tax.species || accession,
        species: tax.species,
        strain: null,
        taxonomy: tax.raw,
        domain: tax.domain,
        phylum: tax.phylum,
        className: tax.className,
        order: tax.order,
        orderName: tax.order,
        family: tax.family,
        genus: tax.genus,
        genomeSource: accession.startsWith('GCF_') ? 'NCBI RefSeq' : 'NCBI GenBank',
        assemblyLevel: null,
        genomeSizeBp: record.genomeSizeBp,
        gcContent: record.gcContent,
        contigCount: record.contigCount,
        completeness: null,
        contamination: null,
        promoterCount: record.promoterCount,
        predictedPromoterCount: record.promoterCount,
        experimentalTssCount: 0,
        hasExperimentalTss: false,
        annotationStatus: record.annotationStatus,
        annotationFeatureCount: record.annotationFeatureCount,
        annotationCircularOriginSplitCount: record.annotationCircularOriginSplitCount,
        annotationIssue: record.annotationIssue,
        primarySequence: record.primarySequence,
        defaultLocus,
        assets,
        checksums,
      };
      const metadata = {
        schemaVersion: 1,
        datasetVersion: options.releaseDate,
        coordinateSystems: { fasta: '1-based sequence', gff3: '1-based closed', browser: '1-based display' },
        ...genome,
      };
      const metadataPath = join(stage, 'objects', assets.metadata);
      await writeJson(metadataPath, metadata);
      const metadataHash = await hashFile(metadataPath);
      genome.checksums.metadata = metadataHash;
      knownHashes.set(`objects/${assets.metadata}`, metadataHash);
      genomes.push(genome);
      totalPromoters += record.promoterCount;
      if (hasAnnotation) annotatedGenomes += 1;
      else if (record.annotationStatus === 'incompatible') incompatibleAnnotationGenomes += 1;
      else missingAnnotationGenomes += 1;
      circularOriginSplitFeatures += record.annotationCircularOriginSplitCount;
      if (record.annotationCircularOriginSplitCount > 0) circularOriginSplitGenomes += 1;
    }

    const generatedAt = `${options.releaseDate}T00:00:00.000Z`;
    const releaseSummary = {
      id: options.releaseDate,
      version: options.releaseDate,
      datasetVersion: options.releaseDate,
      date: options.releaseDate,
      generatedAt,
      genomeCount: genomes.length,
      promoterCount: totalPromoters,
      annotatedGenomeCount: annotatedGenomes,
      usableAnnotationGenomeCount: annotatedGenomes,
      downloadedAnnotationGenomeCount: annotatedGenomes + incompatibleAnnotationGenomes,
      incompatibleAnnotationGenomeCount: incompatibleAnnotationGenomes,
      missingAnnotationGenomeCount: missingAnnotationGenomes,
      circularOriginSplitFeatureCount: circularOriginSplitFeatures,
      circularOriginSplitGenomeCount: circularOriginSplitGenomes,
      experimentalTssCount: 0,
      taxonomySource: 'GTDB taxonomy supplied with gtdb_selected_data_20260807',
      indexed,
      publishable: indexed && options.limit === null,
      preprocessing: indexed ? 'bgzip-tabix-samtools' : 'gzip-only-fallback',
      rawScoreTracks: indexed && scoreEnabled ? { format: 'bigwig', strideBp: 50, promoterPeakCutoff: 0.9 } : null,
    };
    const catalog = {
      schemaVersion: 1,
      generatedAt,
      assetBase: '/api/local-data',
      release: releaseSummary,
      summary: {
        totalGenomes: genomes.length,
        totalPredictedPromoters: totalPromoters,
        totalExperimentalTss: 0,
        annotatedGenomes,
        usableAnnotationGenomes: annotatedGenomes,
        downloadedAnnotationGenomes: annotatedGenomes + incompatibleAnnotationGenomes,
        incompatibleAnnotationGenomes,
        missingAnnotationGenomes,
        circularOriginSplitFeatures,
        circularOriginSplitGenomes,
      },
      genomes,
    };
    await writeJson(join(stage, 'catalog.json'), catalog);
    await writeJson(join(stage, 'release.json'), {
      schemaVersion: 1,
      source: {
        archive: 'gtdb_selected_data_20260807.tar.gz',
        archiveBytes: (await stat(options.archive)).size,
        taxonomyRows: taxonomy.size,
        fastaFiles: sourceFastas.length,
        predictionFiles: sourcePredictions.length,
        ncbiAnnotationFiles: sourceAnnotations.length,
      },
      ...releaseSummary,
    });

    for (const path of ['catalog.json', 'release.json']) knownHashes.set(path, await hashFile(join(stage, path)));
    const manifestRows = ['path\tbytes\tsha256'];
    for (const path of [...knownHashes.keys()].sort()) {
      manifestRows.push(`${path}\t${(await stat(join(stage, path))).size}\t${knownHashes.get(path)}`);
    }
    await writeFile(join(stage, 'manifest.tsv'), `${manifestRows.join('\n')}\n`, 'utf8');
    knownHashes.set('manifest.tsv', await hashFile(join(stage, 'manifest.tsv')));
    const checksumText = [...knownHashes.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([path, digest]) => `${digest}  ${path}`)
      .join('\n');
    await writeFile(join(stage, 'checksums.sha256'), `${checksumText}\n`, 'utf8');
    stageComplete = true;

    try {
      await replaceRelease(stage, options.output, options.force);
      published = true;
    } catch (error) {
      console.error(`Publish failed. The completed stage remains at ${stage}`);
      console.error(`Retry without rebuilding: node scripts/build-gtdb-release.mjs --publish-stage "${stage}" --output "${options.output}"${options.force ? ' --force' : ''}`);
      throw error;
    }
    if (options.appCatalog && !releaseSummary.publishable) {
      console.error('Skipping app catalog copy because the release is not indexed and publishable.');
    } else if (options.appCatalog) {
      await mkdir(dirname(options.appCatalog), { recursive: true });
      await copyFile(join(options.output, 'catalog.json'), options.appCatalog);
    }
    console.error(`Built ${genomes.length} genomes with ${totalPromoters} predicted promoters at ${options.output}`);
  } finally {
    if (!stageComplete || published) {
      await rm(temporary, { recursive: true, force: true });
    } else {
      console.error(`Preserved completed build directory: ${temporary}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.publishStage) {
    await publishPreservedStage(options);
    return;
  }
  if (!isAbsolute(options.archive) || !isAbsolute(options.output)) throw new Error('archive and output paths must resolve to absolute paths');
  if (!(await exists(options.archive))) throw new Error(`source archive does not exist: ${options.archive}`);
  if (options.scoreRoot && !(await exists(options.scoreRoot))) throw new Error(`score root does not exist: ${options.scoreRoot}`);
  const archiveStats = await stat(options.archive);
  const toolchain = detectToolchain(options);
  const scoreRuntime = options.scoreRoot && toolchain.selected ? detectScoreRuntime(toolchain, options) : null;
  console.log(JSON.stringify({
    archive: options.archive,
    archiveBytes: archiveStats.size,
    output: options.output,
    releaseDate: options.releaseDate,
    tools: toolchain,
    scoreInput: options.scoreRoot,
    scoreRuntime: options.scoreRoot ? { required: Boolean(toolchain.selected), available: scoreRuntime } : null,
    fallbackAllowed: options.allowUnindexed,
  }, null, 2));
  if (options.scoreRoot && toolchain.selected && !scoreRuntime) {
    throw new Error('raw score conversion requires Python 3 with pyarrow and pyBigWig in the selected toolchain');
  }
  if (!options.preflightOnly) await build(options, toolchain);
}

export {
  NcbiAnnotationCompatibilityError,
  normalizeGff,
  parseFasta,
  parseTaxonomy,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
