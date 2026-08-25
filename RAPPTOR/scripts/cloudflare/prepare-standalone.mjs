#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDirectory = process.env.RAPPTOR_NEXT_DIST_DIR || '.next';
const standalone = join(root, distDirectory, 'standalone');

if (!existsSync(standalone)) {
  console.error('Standalone output is missing. Run this script after next build.');
  process.exit(1);
}

async function findBundledDataDirectories(directory, depth = 0) {
  if (depth > 4) return [];
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.name === '.data') {
      matches.push(path);
      continue;
    }
    matches.push(...await findBundledDataDirectories(path, depth + 1));
  }
  return matches;
}

const bundledDataDirectories = await findBundledDataDirectories(standalone);
if (bundledDataDirectories.length > 0) {
  console.error('Standalone output unexpectedly contains local release data:');
  for (const path of bundledDataDirectories) console.error(`- ${path}`);
  console.error('Check outputFileTracingExcludes before deploying this build.');
  process.exit(1);
}

const copies = [
  [join(root, distDirectory, 'static'), join(standalone, distDirectory, 'static')],
  [join(root, 'public'), join(standalone, 'public')],
];

for (const [source, destination] of copies) {
  if (!existsSync(source)) continue;
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

console.log('Prepared standalone static assets; local .data release assets are excluded.');
