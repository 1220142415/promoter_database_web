#!/usr/bin/env node

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RELEASE = '2026-08-07';
const DEFAULT_ACCESSIONS = ['GCA_000411415.1', 'GCA_000421325.1'];
const RELEASE_FILES = ['catalog.json', 'release.json', 'manifest.tsv', 'checksums.sha256'];

function parseArguments(argv) {
  const options = { release: DEFAULT_RELEASE, accessions: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--release') options.release = argv[++index];
    else if (value === '--accession') options.accessions.push(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.release || '')) throw new Error('--release must use YYYY-MM-DD');
  if (!options.accessions.length) options.accessions = [...DEFAULT_ACCESSIONS];
  for (const accession of options.accessions) {
    if (!/^(?:GCA|GCF)_\d{9}\.\d+$/.test(accession)) throw new Error(`Invalid accession: ${accession}`);
  }
  return options;
}

function assertWithin(child, parent) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to replace path outside the pilot root: ${child}`);
  }
}

export async function prepareHfPilot({ projectRoot, release, accessions }) {
  const sourceRoot = path.join(projectRoot, '.data', 'releases', release);
  const pilotRoot = path.join(projectRoot, '.data', 'hf-pilot');
  const targetRoot = path.join(pilotRoot, 'releases', release);
  assertWithin(targetRoot, pilotRoot);

  await stat(sourceRoot).catch(() => {
    throw new Error(`Release source is missing: ${sourceRoot}`);
  });
  for (const accession of accessions) {
    await stat(path.join(sourceRoot, 'objects', accession)).catch(() => {
      throw new Error(`Release object is missing: ${accession}`);
    });
  }

  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(path.join(targetRoot, 'objects'), { recursive: true });
  for (const file of RELEASE_FILES) {
    await cp(path.join(sourceRoot, file), path.join(targetRoot, file));
  }
  for (const accession of accessions) {
    await cp(path.join(sourceRoot, 'objects', accession), path.join(targetRoot, 'objects', accession), { recursive: true });
  }

  const manifestLines = (await readFile(path.join(sourceRoot, 'manifest.tsv'), 'utf8')).trimEnd().split(/\r?\n/);
  const selectedRows = manifestLines.slice(1).filter((line) => accessions.some((accession) => line.startsWith(`objects/${accession}/`)));
  await writeFile(path.join(targetRoot, 'pilot-manifest.tsv'), `${manifestLines[0]}\n${selectedRows.join('\n')}\n`);

  const notes = [
    '# SeqEdge Hugging Face pilot',
    '',
    `Release: ${release}`,
    `Accessions: ${accessions.join(', ')}`,
    '',
    'This is a partial object-storage pilot. The release-level catalog and manifests describe the complete 1,000-genome release, while only the listed object directories are included for Range/CORS/JBrowse verification.',
    '',
  ].join('\n');
  await writeFile(path.join(targetRoot, 'SEQEDGE-HF-PILOT.md'), notes);

  let totalBytes = 0;
  for (const row of selectedRows) totalBytes += Number(row.split('\t')[1]);
  return { targetRoot, release, accessions, objectFiles: selectedRows.length, objectBytes: totalBytes };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const scriptPath = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(scriptPath), '..');
  const result = await prepareHfPilot({ projectRoot, ...options });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
