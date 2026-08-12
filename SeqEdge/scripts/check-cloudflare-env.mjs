#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';

const required = ['NEXT_PUBLIC_STORAGE_BASE_URL', 'NEXT_PUBLIC_RELEASE_ASSET_BASE_URL'];

for (const name of required) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required for a Cloudflare build; local /api file routes do not contain release data in Workers.`);
    process.exit(1);
  }
  if (name === 'NEXT_PUBLIC_STORAGE_BASE_URL' && value === '/api/remote-data') continue;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    console.error(`${name} must be an absolute HTTPS URL.`);
    process.exit(1);
  }
  if (parsed.protocol !== 'https:') {
    console.error(`${name} must use HTTPS.`);
    process.exit(1);
  }
}

const wrangler = readFileSync(path.join(process.cwd(), 'wrangler.toml'), 'utf8');
const d1Blocks = wrangler.split(/^\s*\[\[d1_databases\]\]\s*$/m).slice(1);
const catalogBinding = d1Blocks.find((block) => /^\s*binding\s*=\s*["']SEQEDGE_DB["']\s*$/m.test(block));
const databaseId = catalogBinding?.match(/^\s*database_id\s*=\s*["']([0-9a-f-]+)["']\s*$/mi)?.[1];
if (!catalogBinding || !databaseId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(databaseId)) {
  console.error('wrangler.toml must contain a real SEQEDGE_DB D1 binding before a Cloudflare build.');
  process.exit(1);
}

console.log('Cloudflare storage environment is configured.');
