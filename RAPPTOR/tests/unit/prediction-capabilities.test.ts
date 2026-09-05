import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREDICTION_MAX_REQUEST_BYTES,
  formatPredictionMaxRequestBytes,
  predictionCapabilities,
  predictionMaxRequestBytes,
} from '@/features/prediction/capabilities';

const originalLimit = process.env.RAPPTOR_MAX_REQUEST_BYTES;

afterEach(() => {
  if (originalLimit === undefined) delete process.env.RAPPTOR_MAX_REQUEST_BYTES;
  else process.env.RAPPTOR_MAX_REQUEST_BYTES = originalLimit;
});

describe('prediction request limit', () => {
  it('defaults to 12 MiB for missing, invalid, or non-positive values', () => {
    expect(DEFAULT_PREDICTION_MAX_REQUEST_BYTES).toBe(12 * 1024 * 1024);
    expect(predictionMaxRequestBytes('')).toBe(DEFAULT_PREDICTION_MAX_REQUEST_BYTES);
    expect(predictionMaxRequestBytes('invalid')).toBe(DEFAULT_PREDICTION_MAX_REQUEST_BYTES);
    expect(predictionMaxRequestBytes('0')).toBe(DEFAULT_PREDICTION_MAX_REQUEST_BYTES);
    expect(predictionMaxRequestBytes('-1')).toBe(DEFAULT_PREDICTION_MAX_REQUEST_BYTES);
    expect(predictionMaxRequestBytes('1.5')).toBe(DEFAULT_PREDICTION_MAX_REQUEST_BYTES);
    expect(predictionMaxRequestBytes('1e6')).toBe(DEFAULT_PREDICTION_MAX_REQUEST_BYTES);
    expect(predictionMaxRequestBytes('0x100')).toBe(DEFAULT_PREDICTION_MAX_REQUEST_BYTES);
  });

  it('publishes a positive configured byte limit', () => {
    process.env.RAPPTOR_MAX_REQUEST_BYTES = String(20 * 1024 * 1024);
    expect(predictionMaxRequestBytes()).toBe(20 * 1024 * 1024);
    expect(predictionCapabilities().limits.genomeMaxBytes).toBe(20 * 1024 * 1024);
  });

  it('formats custom limits without rounding away bytes', () => {
    expect(formatPredictionMaxRequestBytes(12 * 1024 * 1024)).toBe('12 MiB');
    expect(formatPredictionMaxRequestBytes(1536)).toBe('1,536 bytes');
    expect(formatPredictionMaxRequestBytes(1)).toBe('1 byte');
  });
});
