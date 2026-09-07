import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// Use the locked Wrangler compiler. The original modules remain external and
// are included byte-for-byte in the version upload, together with keep_assets.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const [baseEntry, output] = process.argv.slice(2);
if (!baseEntry || !/^[A-Za-z0-9_./-]+\.m?js$/.test(baseEntry) || baseEntry.includes('..') || baseEntry.startsWith('/')) {
  throw new Error('Pass the downloaded Worker entry module name and an output file.');
}
if (!output) throw new Error('An output file is required.');
const outfile = resolve(output);
await mkdir(dirname(outfile), { recursive: true });
await build({
  stdin: {
    contents: `import deployedWorker from ${JSON.stringify(`./${baseEntry}`)};
export * from ${JSON.stringify(`./${baseEntry}`)};
import { GET, POST } from './src/app/api/internal/prediction-test-tickets/route.ts';
import { withPredictionTestTickets } from './src/features/prediction/test-ticket-overlay.ts';
export default withPredictionTestTickets(deployedWorker, { GET, POST });`,
    resolveDir: process.cwd(), sourcefile: 'prediction-test-overlay-entry.mjs', loader: 'js',
  },
  outfile, bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  external: [`./${baseEntry}`, 'cloudflare:workers'],
  plugins: [{
    name: 'worker-bindings',
    setup(context) {
      context.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'worker-bindings' }));
      context.onResolve({ filter: /^@\/features\/usage\/store$/ }, () => ({ path: 'd1', namespace: 'worker-bindings' }));
      context.onLoad({ filter: /.*/, namespace: 'worker-bindings' }, ({ path }) => ({
        contents: path === 'd1'
          ? "import { env } from 'cloudflare:workers'; export function usageDatabase() { return env.RAPPTOR_DB ?? null; }"
          : 'export {};', loader: 'js',
      }));
    },
  }],
});
const bytes = await readFile(outfile);
await writeFile(`${outfile}.manifest.json`, JSON.stringify({
  baseEntry, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  endpoint: '/api/internal/prediction-test-tickets',
}, null, 2));
console.log(`Built the additive ticket endpoint (${bytes.length} bytes). No remote changes made.`);
