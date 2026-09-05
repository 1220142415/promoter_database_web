import { describe, expect, it } from 'vitest';
import {
  PORTAL_TERMS,
  predictionModeLabel,
  thresholdLabel,
} from '@/components/portal-terminology';

describe('portal display terminology', () => {
  it('maps prediction modes without changing serialized mode values', () => {
    expect(predictionModeLabel('candidate')).toBe('100 bp scoring');
    expect(predictionModeLabel('genome-scan')).toBe('Sequence scan');
    expect(predictionModeLabel('genome_scan')).toBe('Sequence scan');
  });

  it('distinguishes classification and sparse-export thresholds', () => {
    expect(thresholdLabel('candidate')).toBe(PORTAL_TERMS.modelThreshold);
    expect(thresholdLabel('genome-scan')).toBe(PORTAL_TERMS.exportCutoff);
    expect(thresholdLabel('release')).toBe(PORTAL_TERMS.modelThreshold);
  });
});
