import { describe, expect, it } from 'vitest';
import { predictionAccessMode } from '@/features/email-system/access-mode';

describe('prediction access mode', () => {
  it('allows explicit IP mode and fails closed to email mode', () => {
    expect(predictionAccessMode('ip')).toBe('ip');
    expect(predictionAccessMode('email')).toBe('email');
    expect(predictionAccessMode('invalid')).toBe('email');
    expect(predictionAccessMode()).toBe('email');
  });
});
