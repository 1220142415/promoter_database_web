import { FlatCompat } from '@eslint/eslintrc';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: [
      '.next/**',
      '.next-*/**',
      '.open-next/**',
      '.wrangler/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'worker-configuration.d.ts',
    ],
  },
];

export default eslintConfig;
