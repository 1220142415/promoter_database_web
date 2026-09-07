import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname, delimiter } from 'node:path';
import { parseEnv } from 'node:util';

const file = resolve('.env.prediction-local');
const command = process.argv[2];
const defaults = {
  RAPPTOR_DEPLOYMENT_ENV: 'local',
  RAPPTOR_PREDICTION_ENABLED: 'on',
  RAPPTOR_PREDICTION_LOCAL_TEST: 'on',
  NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST: 'on',
  RAPPTOR_LOCAL_TEST_ORIGIN: 'http://127.0.0.1:3000',
  RAPPTOR_LOCAL_TEST_TICKET_ORIGIN: 'https://rapptor.duolalab.qzz.io',
  RAPPTOR_PREDICTION_SERVICE_URL: 'https://4090server.duolalab.qzz.io',
  RAPPTOR_PREDICTION_MODEL_VERSION: 'candidate-github-93cf',
  RAPPTOR_NEXT_DIST_DIR: '.next-codex-preview',
};

async function main() {
  if (!['setup', 'dev', 'publish-key'].includes(command)) throw new Error('Use setup, dev, or publish-key.');
  let contents = '';
  try { contents = await readFile(file, 'utf8'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  if (command === 'setup') {
    const existing = parseEnv(contents);
    const additions = { ...defaults, RAPPTOR_LOCAL_TEST_SECRET: randomBytes(32).toString('hex') };
    const lines = Object.entries(additions).filter(([name]) => !(name in existing)).map(([name, value]) => `${name}=${value}`);
    if (lines.length) await writeFile(file, `${contents}${contents.endsWith('\n') || !contents ? '' : '\n'}${lines.join('\n')}\n`, { mode: 0o600 });
    console.log('Local test configuration is ready in ignored .env.prediction-local. Existing values were preserved; no remote settings changed.');
    return;
  }
  const local = parseEnv(contents);
  if (!/^[a-f0-9]{64}$/.test(local.RAPPTOR_LOCAL_TEST_SECRET || '')) throw new Error('Run npm run prediction:local:setup to create the dedicated local key.');
  if (local.RAPPTOR_LOCAL_TEST_SECRET === process.env.RAPPTOR_PREDICTION_SERVICE_SECRET) throw new Error('Development and model service keys must be different.');
  let executableArgs;
  let env;
  if (command === 'publish-key') {
    // Deliberately update only this Secret on the approved existing Worker.
    executableArgs = ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'RAPPTOR_LOCAL_TEST_SECRET', '--name', 'rapptor'];
    env = { ...process.env };
  } else {
    const origin = new URL(local.RAPPTOR_LOCAL_TEST_ORIGIN);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.href !== `${origin.origin}/`) throw new Error('The local server must bind to an http://127.0.0.1 origin.');
    executableArgs = ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', origin.port || '80', '--turbopack'];
    env = { ...process.env, ...local, NODE_ENV: 'development' };
  }
  env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH || ''}`;
  const child = spawn(process.execPath, executableArgs, { env, stdio: [command === 'publish-key' ? 'pipe' : 'inherit', 'inherit', 'inherit'], windowsHide: true });
  if (command === 'publish-key') child.stdin.end(`${local.RAPPTOR_LOCAL_TEST_SECRET}\n`);
  child.on('error', () => { console.error('Could not start the local prediction command.'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}

main().catch((cause) => { console.error(cause.message); process.exitCode = 1; });
