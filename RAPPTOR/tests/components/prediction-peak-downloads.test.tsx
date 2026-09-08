// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import ResultDownloads from '@/features/prediction/components/result-downloads';
import ResultInformation from '@/features/prediction/components/result-information';

it('prefers peaks GFF3 while retaining both raw BigWigs as one download', () => {
  const artifacts = ['peaks.gff3', 'scores.gff3', 'scores.plus.bw', 'scores.minus.bw'].map(filename => ({ filename, format: 'gff3', size_bytes: 1, sha256: 'hash' }));
  render(<ResultDownloads jobId="a" artifacts={artifacts} mode="genome_scan" expiresAt="tomorrow" />);
  expect(screen.getByRole('link', { name: /Predicted peaks/ })).toHaveAttribute('href', '/api/predictions/jobs/a/artifacts/peaks.gff3');
  expect(screen.getByRole('link', { name: /Model score tracks/ })).toHaveAttribute('href', '/api/predictions/jobs/a/artifacts/model-score-tracks.zip');
  expect(screen.getAllByRole('link')).toHaveLength(2);
  expect(screen.queryByText(/GFF3 is unavailable/)).not.toBeInTheDocument();
});

it('shows the recorded peak rule without conflating it with a window export cutoff', () => {
  render(<ResultInformation inputName="input.fa" refName="a" summary={{ mode: 'genome_scan', score_cutoff: .4, peak_count: 0, peak_calling: { cutoff: .9, distance: 10, operator: '>' }, smoothing: { method: 'gaussian', sigma: 1, mode: 'reflect' } }} />);
  expect(screen.getByText(/Peak cutoff: smoothed model score > 0.9/)).toBeInTheDocument();
  expect(screen.queryByText(/Export cutoff/)).not.toBeInTheDocument();
});
