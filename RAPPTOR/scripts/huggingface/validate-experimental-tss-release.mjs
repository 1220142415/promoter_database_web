import { resolve } from 'node:path';
import {
  EXPERIMENTAL_TSS_BASELINE,
  validateExperimentalRelease,
  validateExperimentalSource,
} from './lib/experimental-tss-release.mjs';

const args = process.argv.slice(2);
let root = null;
let source = null;
let originalSource = null;
let trustSourceChecksums = false;
let expected = EXPERIMENTAL_TSS_BASELINE;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--release') {
    if (!args[index + 1]) throw new Error('--release requires a path');
    root = resolve(args[index + 1]);
    index += 1;
  } else if (args[index] === '--source') {
    if (!args[index + 1]) throw new Error('--source requires a path');
    source = resolve(args[index + 1]);
    index += 1;
  } else if (args[index] === '--original-source') {
    if (!args[index + 1]) throw new Error('--original-source requires a path');
    originalSource = resolve(args[index + 1]);
    index += 1;
  } else if (args[index] === '--trust-source-checksums') trustSourceChecksums = true;
  else if (args[index] === '--allow-subset') expected = false;
  else if (args[index] === '--help' || args[index] === '-h') {
    console.log(`Usage:
  node scripts/validate-experimental-tss-release.mjs --release PATH [--allow-subset]
  node scripts/validate-experimental-tss-release.mjs --source PATH --original-source PATH [--allow-subset]
  node scripts/validate-experimental-tss-release.mjs --source PATH --trust-source-checksums [--allow-subset]`);
    process.exit(0);
  } else throw new Error(`unknown argument: ${args[index]}`);
}
if (Boolean(root) === Boolean(source)) throw new Error('provide exactly one of --release or --source');
const result = root
  ? await validateExperimentalRelease(root, { expected })
  : await validateExperimentalSource(source, { expected, originalSourceRoot: originalSource, trustSourceChecksums });
console.log(JSON.stringify(result, null, 2));
