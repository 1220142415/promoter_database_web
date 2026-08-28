#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function windowsNode20() {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) === 20) return process.execPath;
  const root = process.env.NVM_HOME;
  if (!root || !existsSync(root)) return null;
  const versions = readdirSync(root)
    .filter((name) => /^v20\.\d+\.\d+$/u.test(name))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  return versions.map((version) => join(root, version, 'node.exe')).find(existsSync) || null;
}

const node = windowsNode20();
if (!node) {
  console.error('OpenNext on Windows requires Node.js 20. Install it with `nvm install 20` and retry.');
  process.exit(1);
}
if (node !== process.execPath) console.log(`Using ${node} for the Windows OpenNext build.`);

const cli = join(process.cwd(), 'node_modules', '@opennextjs', 'cloudflare', 'dist', 'cli', 'index.js');
const result = spawnSync(node, [cli, 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH || ''}` },
});
process.exit(result.status ?? 1);
