import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireNcbiGenomeAssets,
  buildExperimentalRelease,
  EXPERIMENTAL_TSS_BASELINE,
  parseExperimentalManifest,
} from './lib/experimental-tss-release.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const result = {
    sourceRoot: null,
    originalSourceRoot: null,
    ncbiRoot: null,
    output: null,
    releaseId: null,
    releaseDate: null,
    pubmedCache: null,
    assetBase: null,
    hfRepository: null,
    hfRevision: 'main',
    offline: false,
    fetchNcbi: false,
    datasetsCommand: 'datasets',
    trustSourceChecksums: false,
    allowUnindexed: false,
    force: false,
    expected: EXPERIMENTAL_TSS_BASELINE,
  };
  const value = (index, argument) => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${argument} requires a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') { result.sourceRoot = resolve(value(index, argument)); index += 1; }
    else if (argument === '--original-source') { result.originalSourceRoot = resolve(value(index, argument)); index += 1; }
    else if (argument === '--ncbi-assets') { result.ncbiRoot = resolve(value(index, argument)); index += 1; }
    else if (argument === '--output') { result.output = resolve(value(index, argument)); index += 1; }
    else if (argument === '--release') { result.releaseId = value(index, argument); index += 1; }
    else if (argument === '--release-date') { result.releaseDate = value(index, argument); index += 1; }
    else if (argument === '--pubmed-cache') { result.pubmedCache = resolve(value(index, argument)); index += 1; }
    else if (argument === '--asset-base') { result.assetBase = value(index, argument); index += 1; }
    else if (argument === '--hf-repository') { result.hfRepository = value(index, argument); index += 1; }
    else if (argument === '--hf-revision') { result.hfRevision = value(index, argument); index += 1; }
    else if (argument === '--offline') result.offline = true;
    else if (argument === '--fetch-ncbi') result.fetchNcbi = true;
    else if (argument === '--datasets-command') { result.datasetsCommand = value(index, argument); index += 1; }
    else if (argument === '--trust-source-checksums') result.trustSourceChecksums = true;
    else if (argument === '--allow-unindexed') result.allowUnindexed = true;
    else if (argument === '--allow-subset') result.expected = false;
    else if (argument === '--force') result.force = true;
    else if (argument === '--help' || argument === '-h') {
      console.log(`Usage: node scripts/build-experimental-tss-release.mjs --source PATH --ncbi-assets PATH --output PATH --release ID --release-date YYYY-MM-DD [options]

Inputs:
  --source PATH          Directory containing manifest.tsv and the 98 normalized BED files
  --original-source PATH Original BED directory used to verify source_sha256 (recommended for production)
  --ncbi-assets PATH     Per-accession reference/annotation asset directories
  --fetch-ncbi           Fill missing accession directories using the NCBI Datasets CLI
  --datasets-command CMD NCBI Datasets executable (default: datasets)
  --pubmed-cache PATH    Read and update reproducible PubMed metadata JSON

Output/storage:
  --output PATH          Versioned release directory (use a large data volume)
  --asset-base URL       Public HTTPS release asset base (required for the complete production release)
  --hf-repository ID     Hugging Face dataset repository recorded in D1 import SQL
  --hf-revision REV      Hugging Face revision (default: main)

Validation:
  --offline              Do not query PubMed for cache misses
  --trust-source-checksums
                         Explicitly accept recorded source hashes when original BEDs are unavailable
  --allow-unindexed      Build a gzip-only development release
  --allow-subset         Disable the 98/90/78/440947 production baseline check
  --force                Replace an existing completed output`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  for (const key of ['sourceRoot', 'ncbiRoot', 'output', 'releaseId', 'releaseDate']) {
    if (!result[key]) throw new Error(`missing required option: ${key}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(result.releaseId)) throw new Error('invalid release ID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result.releaseDate)) throw new Error('release date must be YYYY-MM-DD');
  if (result.output.startsWith(projectRoot)) {
    console.error('WARNING: release output is inside the project tree; production assets should be written to a large data volume.');
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));
if (options.fetchNcbi) {
  const manifest = await parseExperimentalManifest(options.sourceRoot, { expected: options.expected });
  const acquisition = await acquireNcbiGenomeAssets(
    manifest.rows.map((row) => row.accession),
    options.ncbiRoot,
    { datasetsCommand: options.datasetsCommand, onWarning: (warning) => console.error(`WARNING: ${warning}`) },
  );
  console.error(`NCBI assets: downloaded ${acquisition.downloaded.length}, reused ${acquisition.reused.length}`);
}
const result = await buildExperimentalRelease(options);
console.log(JSON.stringify({ output: result.output, summary: result.catalog.summary, warnings: result.warnings }, null, 2));
