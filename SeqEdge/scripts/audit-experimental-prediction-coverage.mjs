#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  auditExperimentalPredictionCoverage,
  coverageAuditToTsv,
  loadCatalogEntries,
  loadHfInputMapping,
  mergeEntryMaps,
  parseExperimentalManifestText,
} from './lib/experimental-prediction-coverage.mjs';

function usage() {
  return `Usage:
  node scripts/audit-experimental-prediction-coverage.mjs \\
    [--experimental-catalog PATH] [--experimental-manifest PATH] \\
    [--prediction-catalog PATH ...] [--prediction-mapping PATH ...] \\
    (--output-dir DIR | --json PATH --tsv PATH)

At least one experimental source and one prediction source are required.
Prediction catalogs and HF input_mapping.tsv files may be repeated. Reciprocal
GCA/GCF matches are considered only when an explicit paired accession is present;
the audit never guesses from organism names or numeric accession stems.`;
}

function parseArgs(argv) {
  const options = {
    experimentalCatalog: null,
    experimentalManifest: null,
    predictionCatalogs: [],
    predictionMappings: [],
    json: null,
    tsv: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      if (!argv[index + 1]) throw new Error(`${argument} requires a path`);
      index += 1;
      return resolve(argv[index]);
    };
    if (argument === '--experimental-catalog') options.experimentalCatalog = value();
    else if (argument === '--experimental-manifest') options.experimentalManifest = value();
    else if (argument === '--prediction-catalog') options.predictionCatalogs.push(value());
    else if (argument === '--prediction-mapping') options.predictionMappings.push(value());
    else if (argument === '--json') options.json = value();
    else if (argument === '--tsv') options.tsv = value();
    else if (argument === '--output-dir') {
      const root = value();
      options.json = join(root, 'experimental-prediction-coverage.json');
      options.tsv = join(root, 'experimental-prediction-coverage.tsv');
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.experimentalCatalog && !options.experimentalManifest) throw new Error('provide an experimental catalog and/or manifest');
  if (!options.predictionCatalogs.length && !options.predictionMappings.length) throw new Error('provide at least one prediction catalog or HF input_mapping.tsv');
  if (!options.json || !options.tsv) throw new Error('provide --output-dir or both --json and --tsv');
  if (options.json === options.tsv) throw new Error('JSON and TSV output paths must differ');
  return options;
}

async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}

const experimentalMaps = [];
if (options.experimentalCatalog) experimentalMaps.push(await loadCatalogEntries(options.experimentalCatalog, 'experimental_catalog'));
if (options.experimentalManifest) {
  experimentalMaps.push(parseExperimentalManifestText(await readFile(options.experimentalManifest, 'utf8')));
}
const predictionMaps = [];
for (const path of options.predictionCatalogs) predictionMaps.push(await loadCatalogEntries(path, 'prediction_catalog'));
for (const path of options.predictionMappings) predictionMaps.push(await loadHfInputMapping(path, 'hf_input_mapping'));

const audit = auditExperimentalPredictionCoverage(
  mergeEntryMaps(experimentalMaps),
  mergeEntryMaps(predictionMaps),
  { experimentalCatalogExpected: Boolean(options.experimentalCatalog && options.experimentalManifest) },
);
await atomicWrite(options.json, `${JSON.stringify(audit, null, 2)}\n`);
await atomicWrite(options.tsv, coverageAuditToTsv(audit));
console.log(JSON.stringify({ json: options.json, tsv: options.tsv, summary: audit.summary }, null, 2));
