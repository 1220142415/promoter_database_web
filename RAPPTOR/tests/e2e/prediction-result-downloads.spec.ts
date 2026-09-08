import { expect, test } from '@playwright/test';

const jobId = 'b'.repeat(32);
const filenames = ['scores.gff3', 'scores.plus.bw', 'scores.minus.bw', 'scores.parquet', 'summary.json'];

for (const width of [390, 1024]) {
  test(`simplified downloads and information fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 920 });
    await page.addInitScript(({ jobId }) => {
      localStorage.setItem('rapptor-prediction-history', JSON.stringify([{
        jobId, token: 'ui-fixture-token', refName: 'chr1', status: 'succeeded', mode: 'genome_scan',
        submittedAt: '2026-09-08T03:01:05Z', label: 'Test genome', bases: 300,
      }]));
    }, { jobId });
    await page.route(`**/api/predictions/jobs/${jobId}**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/session')) return route.fulfill({ json: { authorized: true } });
      if (path.endsWith('/summary.json')) return route.fulfill({ json: {
        mode: 'genome_scan', total_bases: 300, contig_count: 1, window_count: 402,
        passing_window_count: 2, score_cutoff: .9, score_cutoff_operator: '>', stride: 1,
        reverse_complementary: true, cgr_source: 'complete_genome_assembly_fasta',
        model: { seq_length: 100, model_version: 'fixture-v1', checkpoint_sha256: 'fixture-checkpoint', model_asset_status: 'candidate_not_production' },
      } });
      return route.fulfill({ json: {
        job_id: jobId, status: 'succeeded', artifacts_expires_at: '2026-09-09T03:01:05Z',
        result: { artifacts: filenames.map((filename) => ({ filename, format: filename.split('.').at(-1), size_bytes: 100, sha256: 'fixture' })) },
      } });
    });
    await page.goto(`/predict/task/${jobId}`);
    const downloads = page.getByRole('region', { name: 'Download result' });
    await expect(downloads).toBeVisible();
    await expect(downloads.getByRole('link')).toHaveCount(2);
    const info = page.getByRole('region', { name: 'Prediction information' });
    await expect(info.getByText('RAPPtor', { exact: true })).toBeVisible();
    await expect(info.getByText('fixture-checkpoint')).not.toBeVisible();
    await expect(downloads.getByText('scores.parquet')).not.toBeVisible();
    await expect(downloads.getByText('Additional files', { exact: true })).toHaveCount(0);
    await expect(info.getByText('Run details', { exact: true })).toHaveCount(0);
    await expect(info.getByRole('term')).toHaveCount(3);
    await expect(downloads.getByRole('link', { name: /Prediction results GFF3/ })).toHaveAttribute('href', `/api/predictions/jobs/${jobId}/artifacts/scores.gff3`);
    await expect(downloads.getByRole('link', { name: /Model score tracks ZIP/ })).toHaveAttribute('href', `/api/predictions/jobs/${jobId}/artifacts/model-score-tracks.zip`);

    for (const section of [downloads, info]) {
      expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      for (const link of await section.getByRole('link').all()) {
        const box = await link.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
    }
    await downloads.screenshot({ path: testInfo.outputPath(`downloads-${width}.png`) });
    await info.screenshot({ path: testInfo.outputPath(`information-${width}.png`) });
  });
}
