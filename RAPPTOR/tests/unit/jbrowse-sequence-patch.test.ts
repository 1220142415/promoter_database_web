import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('JBrowse feature sequence patch', () => {
  it('keeps the SimpleFeature identity stable across renders', () => {
    const modulePath = require.resolve(
      '@jbrowse/core/BaseFeatureWidget/SequenceFeatureDetails/SequenceFeatureDetails.js',
    );
    const source = readFileSync(modulePath, 'utf8');

    expect(source).toContain(
      'const simpleFeature = (0, react_1.useMemo)(() => new util_1.SimpleFeature(feature), [feature]);',
    );
    expect(source).toContain('feature: simpleFeature,');
    expect(source).not.toContain('feature: new util_1.SimpleFeature(feature),');
  });
});
