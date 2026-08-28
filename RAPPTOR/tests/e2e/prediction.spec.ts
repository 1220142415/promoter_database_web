import { expect, test } from '@playwright/test';

test('homepage demo prediction reaches a protected result without uploading sequence data', async ({ page }) => {
  const predictionBodies: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/predictions/demo') {
      predictionBodies.push(request.postData() || '');
    }
  });

  await page.goto('/#predict');
  await expect(page.getByRole('heading', { name: 'Predict a promoter candidate' })).toBeVisible();
  await expect(page.getByText('DEMO PREVIEW')).toBeVisible();
  await page.getByRole('button', { name: 'Use example' }).click();

  const search = page.getByPlaceholder('GCA_000411415.1 or organism name');
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/genomes' && response.ok()),
    search.fill('GCA_000411415.1'),
  ]);
  await page.getByRole('button', { name: /GCA_000411415\.1/ }).click();
  await Promise.all([
    page.waitForURL(/\/predict\/demo_/),
    page.getByRole('button', { name: 'Preview demo result' }).click(),
  ]);

  await expect(page.getByRole('heading', { name: 'Demo result preview' })).toBeVisible();
  await expect(page.getByText('Result ready')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('RAPPtor model-positive candidate')).toBeVisible();
  await expect(page.getByText('Both (+/−)')).toBeVisible();
  await expect(page.getByTestId('prediction-summary').getByText('Best promoter window')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Top promoter windows' })).toBeVisible();
  await expect(page.getByText(/TSS/i)).toHaveCount(0);
  await expect(page.getByText('Every score on this page is a deterministic interface fixture. It must not be interpreted as biological output.')).toBeVisible();
  await expect(page.getByTestId('prediction-summary')).toHaveCSS('display', 'grid');
  await expect(page.getByTestId('prediction-score-plus')).toHaveCSS('fill', 'none');
  await expect(page.getByTestId('prediction-score-plus')).not.toHaveCSS('stroke', 'none');
  await expect(page.getByTestId('prediction-best-window')).toBeVisible();
  await expect(page.getByText(/window intervals ×/i)).toHaveCount(0);
  await expect(page.getByText('Anchor rule')).toHaveCount(0);
  await expect(page.getByText('Demo limitation')).toHaveCount(0);
  await expect(page.getByTestId('prediction-window-map')).toContainText('9–108 · anchor 88 · + strand');
  await expect(page.getByTestId('prediction-window-map')).toContainText('Base 80 = prediction anchor');
  await expect(page.getByText('Candidate SHA-256')).toHaveCount(0);
  await expect(page.getByText('Genome SHA-256')).toHaveCount(0);
  await expect(page.getByText('CGR converter')).toHaveCount(0);
  expect(predictionBodies).toHaveLength(1);
  expect(predictionBodies[0]).not.toContain('TTGACA');
  const submission = JSON.parse(predictionBodies[0]);
  expect(submission).toMatchObject({ contractVersion: 2, predictionKind: 'candidate', strandMode: 'both' });
  expect(submission.target.sequence).toBeUndefined();
});

test.describe('mobile prediction form', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('keeps both prediction inputs within the viewport', async ({ page }) => {
    await page.goto('/#predict');
    await expect(page.getByLabel('Candidate DNA sequence')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Catalog assembly' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.getByRole('button', { name: 'Use example' }).click();
    const search = page.getByPlaceholder('GCA_000411415.1 or organism name');
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/genomes' && response.ok()),
      search.fill('GCA_000411415.1'),
    ]);
    await page.getByRole('button', { name: /GCA_000411415\.1/ }).click();
    await Promise.all([
      page.waitForURL(/\/predict\/demo_/),
      page.getByRole('button', { name: 'Preview demo result' }).click(),
    ]);
    await expect(page.getByTestId('prediction-summary')).toBeVisible({ timeout: 10_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
