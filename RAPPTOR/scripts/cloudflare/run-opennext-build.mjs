#!/usr/bin/env node

import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Current Wrangler requires Node 22+. Do not silently downgrade Windows builds
// to a Node 20 installation that cannot run the locked deployment toolchain.
const node = process.execPath;
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('The Cloudflare build requires Node.js 22 or newer.');
  process.exit(1);
}

const cli = join(process.cwd(), 'node_modules', '@opennextjs', 'cloudflare', 'dist', 'cli', 'index.js');
const result = spawnSync(node, [cli, 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH || ''}` },
});
process.exit(result.status ?? 1);
