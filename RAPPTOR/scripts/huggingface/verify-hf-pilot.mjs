#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RELEASE = '2026-08-07';
const DEFAULT_ACCESSIONS = ['GCA_000411415.1', 'GCA_000421325.1'];
const TEST_ORIGIN = 'http://127.0.0.1:3100';

function parseArguments(argv) {
  const options = { repo: process.env.HF_REPO_ID || '', release: DEFAULT_RELEASE, revision: 'main', endpoint: process.env.HF_ENDPOINT || 'https://huggingface.co' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--repo') options.repo = argv[++index];
    else if (value === '--release') options.release = argv[++index];
    else if (value === '--revision') options.revision = argv[++index];
    else if (value === '--endpoint') options.endpoint = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.repo || !/^[^/\s]+\/[^/\s]+$/.test(options.repo)) throw new Error('Provide --repo owner/name or set HF_REPO_ID.');
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'https:') throw new Error('--endpoint must use HTTPS.');
  options.endpoint = endpoint.origin;
  return options;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function request(url, init = {}) {
  const response = await fetch(url, { redirect: 'follow', ...init });
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${url} returned ${response.status}`);
  return response;
}

function assertCors(response, url) {
  const value = response.headers.get('access-control-allow-origin');
  if (value !== '*' && value !== TEST_ORIGIN) throw new Error(`${url} does not allow browser CORS for ${TEST_ORIGIN}`);
}

async function verifyRange(url) {
  const response = await request(url, { headers: { Range: 'bytes=0-127', Origin: TEST_ORIGIN, 'Accept-Encoding': 'identity' } });
  if (response.status !== 206) throw new Error(`${url} returned ${response.status}; JBrowse requires 206 Partial Content`);
  if (!/^bytes 0-127\/\d+$/.test(response.headers.get('content-range') || '')) throw new Error(`${url} returned an invalid Content-Range`);
  assertCors(response, url);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== 128) throw new Error(`${url} returned ${body.length} bytes for a 128-byte Range request`);
}

export async function verifyHfPilot({ projectRoot, repo, release, revision, endpoint = 'https://huggingface.co' }) {
  const releaseRoot = path.join(projectRoot, '.data', 'releases', release);
  const manifest = (await readFile(path.join(releaseRoot, 'manifest.tsv'), 'utf8')).trimEnd().split(/\r?\n/).slice(1);
  const expected = new Map(manifest.map((line) => {
    const [file, bytes, digest] = line.split('\t');
    return [file, { bytes: Number(bytes), digest }];
  }));
  const base = `${endpoint.replace(/\/+$/, '')}/datasets/${repo}/resolve/${encodeURIComponent(revision)}/releases/${release}`;
  const files = manifest.map((line) => line.split('\t')[0]).filter((file) => DEFAULT_ACCESSIONS.some((accession) => file.startsWith(`objects/${accession}/`)));
  const rangeFiles = files.filter((file) => file.endsWith('.fa.gz') || file.endsWith('.gff3.gz'));

  for (const file of rangeFiles) await verifyRange(`${base}/${file}`);

  let verifiedBytes = 0;
  for (const file of files) {
    const url = `${base}/${file}`;
    const response = await request(url, { headers: { Origin: TEST_ORIGIN } });
    assertCors(response, url);
    const body = Buffer.from(await response.arrayBuffer());
    const expectation = expected.get(file);
    if (body.length !== expectation.bytes) throw new Error(`${file}: expected ${expectation.bytes} bytes, received ${body.length}`);
    if (sha256(body) !== expectation.digest) throw new Error(`${file}: SHA-256 mismatch`);
    verifiedBytes += body.length;
  }

  return {
    repo,
    endpoint,
    release,
    files: files.length,
    verifiedBytes,
    rangeFiles: rangeFiles.length,
    storageBaseUrl: `${base}/objects`,
    releaseAssetBaseUrl: base,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  console.log(JSON.stringify(await verifyHfPilot({ projectRoot, ...options }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
