// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import ResultDownloads from '@/features/prediction/components/result-downloads';
import ResultInformation from '@/features/prediction/components/result-information';

it('labels new BigWigs as smoothed while retaining raw wording for legacy tasks', () => {
  const artifacts = ['peaks.gff3', 'scores.gff3', 'scores.plus.bw', 'scores.minus.bw'].map(filename => ({ filename, format: 'gff3', size_bytes: 1, sha256: 'hash' }));
  const { rerender } = render(<ResultDownloads jobId="a" artifacts={artifacts} mode="genome_scan" expiresAt="tomorrow" bigwigSmoothing={{ method: 'gaussian', sigma: 1, mode: 'reflect' }} />);
  expect(screen.getByRole('link', { name: /Predicted peaks/ })).toHaveAttribute('href', '/api/predictions/jobs/a/artifacts/peaks.gff3');
  expect(screen.getByRole('link', { name: /Model score tracks/ })).toHaveAttribute('href', '/api/predictions/jobs/a/artifacts/model-score-tracks.zip');
  expect(screen.getByRole('link', { name: /Model score tracks/ })).toHaveTextContent('Gaussian-smoothed forward and reverse BigWig files in one folder');
  expect(screen.getAllByRole('link')).toHaveLength(2);
  expect(screen.queryByText(/GFF3 is unavailable/)).not.toBeInTheDocument();
  rerender(<ResultDownloads jobId="a" artifacts={artifacts} mode="genome_scan" expiresAt="tomorrow" />);
  expect(screen.getByRole('link', { name: /Model score tracks/ })).toHaveTextContent('Raw forward and reverse BigWig files in one folder');
});

it('shows the recorded peak rule without conflating it with a window export cutoff', () => {
  render(<ResultInformation inputName="input.fa" refName="a" summary={{ mode: 'genome_scan', score_cutoff: .4, peak_count: 0, peak_calling: { cutoff: .9, distance: 10, operator: '>' }, smoothing: { method: 'gaussian', sigma: 1, mode: 'reflect' } }} />);
  expect(screen.getByText('Cutoff: > 0.9')).toBeInTheDocument();
  expect(screen.queryByText(/Export cutoff/)).not.toBeInTheDocument();
});

it('keeps peak parameters and downloads for short sequences longer than 100 bp', () => {
  const artifacts = ['scores.json', 'peaks.gff3'].map(filename => ({ filename, format: filename.split('.').at(-1)!, size_bytes: 1, sha256: 'hash' }));
  render(<>
    <ResultDownloads jobId="long" artifacts={artifacts} mode="predict" expiresAt="tomorrow" />
    <ResultInformation inputName="sequence" refName="" summary={{ mode: 'predict', sequence_bases: 101, reverse_complementary: true, peak_calling: { cutoff: .9, distance: 10, operator: '>' }, smoothing: { method: 'gaussian', sigma: 1, mode: 'reflect' } }} />
  </>);
  expect(screen.getByRole('region', { name: 'Download result' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Prediction results TSV/ })).toHaveAttribute('href', '/api/predictions/jobs/long/artifacts/prediction-results.tsv');
  expect(screen.getByRole('link', { name: /Predicted peaks/ })).toBeInTheDocument();
  expect(screen.getByText('Cutoff: > 0.9')).toBeInTheDocument();
  expect(screen.queryByText(/Min\. distance|σ/)).not.toBeInTheDocument();
});
