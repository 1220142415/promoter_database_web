import { describe, expect, it } from 'vitest';
import { parsePredictionHistory, upsertPredictionHistory, type PredictionHistoryEntry } from '@/features/prediction/history';

const entry = (index: number, status: PredictionHistoryEntry['status'] = 'queued'): PredictionHistoryEntry => ({
  jobId: index.toString(16).padStart(32, '0'),
  token: `token-${index}`,
  refName: `ref-${index}`,
  status,
  mode: 'genome_scan',
  submittedAt: `2026-08-29T00:00:${String(index).padStart(2, '0')}Z`,
  label: `genome-${index}.fna`,
  bases: 100 + index,
});

describe('prediction browser history', () => {
  it('rejects malformed storage and keeps only valid entries', () => {
    expect(parsePredictionHistory('{')).toEqual([]);
    expect(parsePredictionHistory(JSON.stringify([entry(1), { jobId: 'bad' }]))).toEqual([entry(1)]);
  });

  it('moves an updated job to the front and caps history at 20', () => {
    const current = Array.from({ length: 20 }, (_, index) => entry(index));
    const updated = upsertPredictionHistory(current, entry(10, 'succeeded'));
    expect(updated).toHaveLength(20);
    expect(updated[0]).toEqual(entry(10, 'succeeded'));
    expect(updated.filter((item) => item.jobId === entry(10).jobId)).toHaveLength(1);
  });
});
