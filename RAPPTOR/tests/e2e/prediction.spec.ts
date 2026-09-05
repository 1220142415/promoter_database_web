import { expect, test, type Page } from '@playwright/test';

function capturePredictionApiRequests(page: Page) {
  const requests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/predictions' || path.startsWith('/api/predictions/')) {
      requests.push(`${request.method()} ${path}`);
    }
  });
  return requests;
}

async function storedPrototypeRuns(page: Page) {
  return page.evaluate(() => Object.entries(window.sessionStorage)
    .filter(([key]) => key.startsWith('rapptor:prediction-prototype:'))
    .map(([key, value]) => ({ key, value })));
}

async function uploadCgrContext(page: Page, fileName = 'matching-context.fna') {
  await page.locator('input[type="file"]').last().setInputFiles({
    name: fileName,
    mimeType: 'text/plain',
    buffer: Buffer.from(`>matching_context\n${'ACGT'.repeat(40)}\n`),
  });
  await expect(page.getByText('Genome context ready: Matching genome FASTA.')).toBeVisible();
}

test('the 100 bp example keeps the focused result compact and metadata-only', async ({ page }) => {
  test.setTimeout(120_000);
  const predictionRequests = capturePredictionApiRequests(page);

  await page.goto('/predict');
  await expect(page.getByRole('heading', { name: 'Add input. RAPPTOR selects the analysis.' })).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByLabel('Raw DNA or FASTA')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload FASTA' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Accession, organism, or strain' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Use 100 bp example' }).click();
  const sequenceInput = page.getByLabel('Raw DNA or FASTA');
  await expect(sequenceInput).toHaveValue(/focused_candidate_100bp/);
  await expect(page.getByText('100 bp scoring').first()).toBeVisible();
  await expect(page.getByText('Select a catalog genome or upload its FASTA.').first()).toBeVisible();
  await expect(page.getByLabel('Top results')).toHaveCount(0);
  const previewButton = page.getByRole('button', { name: 'Preview illustrative result' });
  await expect(previewButton).toBeEnabled();
  await previewButton.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Genome context (CGR) is required' })).toBeVisible();
  await expect(page).toHaveURL(/\/predict$/);
  await page.getByRole('button', { name: 'Use this genome' }).click();
  await expect(page.getByText('Genome context ready: Catalog genome.')).toBeVisible();

  await Promise.all([
    page.waitForURL(/\/predict\/demo\/prototype_/),
    page.getByRole('button', { name: 'Preview illustrative result' }).click(),
  ]);

  const progress = page.getByRole('region', { name: 'Prediction progress' });
  await expect(progress).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Prediction task progress' })).toBeVisible();
  const beforeReload = Number(await page.getByRole('progressbar', { name: 'Prediction task progress' }).getAttribute('value') || 0);
  await page.waitForTimeout(650);
  await page.reload();
  const afterReload = Number(await page.getByRole('progressbar', { name: 'Prediction task progress' }).getAttribute('value') || 0);
  expect(afterReload).toBeGreaterThanOrEqual(beforeReload);
  await expect(page.getByRole('heading', { name: 'Prediction result' })).toBeVisible();
  await expect(page.getByText('100 bp scoring')).toBeVisible();
  await expect(page.getByRole('heading', { name: '100 bp result' })).toBeVisible({ timeout: 10_000 });
  await expect(progress).toContainText('Result ready');
  await expect(page.getByRole('meter', { name: /Forward strand.*illustrative model score/ })).toBeVisible();
  await expect(page.getByRole('meter', { name: /Reverse strand.*illustrative model score/ })).toBeVisible();
  await expect(page.getByText('100 bp anchor positions')).toHaveCount(0);
  await expect(page.getByText(/Anchor base/)).toHaveCount(0);
  await expect(page.getByTestId('prototype-prediction-browser')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download GFF3' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download bedGraph' })).toBeVisible();

  const stored = await storedPrototypeRuns(page);
  expect(stored).toHaveLength(1);
  expect(stored[0].value).not.toContain('focused_candidate_100bp');
  expect(stored[0].value).not.toContain('ACGTACGTACGT');
  expect(stored[0].value).not.toMatch(/"(?:sequence|fasta)"\s*:/i);
  const payload = JSON.parse(stored[0].value);
  expect(payload).toMatchObject({
    schemaVersion: 3,
    mode: 'candidate',
    parameters: { strandMode: 'both', cutoff: 0.9, strideBases: 1 },
    input: { kind: 'candidate', length: 100, checksum: expect.any(String) },
  });
  expect(payload.parameters).not.toHaveProperty('topK');
  expect(predictionRequests).toEqual([]);
});

test('the E. coli K-12 example opens an illustrative JBrowse genome scan', async ({ page }) => {
  const predictionRequests = capturePredictionApiRequests(page);

  await page.goto('/predict');
  await page.getByRole('button', { name: 'Use E. coli K-12 genome example' }).click();
  await expect(page.getByText('Sequence scan').first()).toBeVisible();
  await expect(page.getByText(/Escherichia coli str\. K-12/).first()).toBeVisible();
  await expect(page.getByText('Genome context required')).toBeVisible();
  await uploadCgrContext(page);
  await page.getByLabel('Strands').selectOption('forward');
  await page.getByLabel('Export cutoff').fill('0.80');
  await page.getByLabel('Stride').selectOption('10');
  await expect(page.getByLabel('Top results')).toHaveCount(0);

  await Promise.all([
    page.waitForURL(/\/predict\/demo\/prototype_/),
    page.getByRole('button', { name: 'Preview illustrative result' }).click(),
  ]);

  await expect(page.getByRole('region', { name: 'Prediction progress' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Prediction task progress' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Prediction result' })).toBeVisible();
  await expect(page.getByText('Sequence scan')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Genome browser' }).first()).toBeVisible({ timeout: 12_000 });
  await expect(page.getByRole('region', { name: 'Prediction progress' })).toContainText('Result ready');
  const browser = page.getByTestId('prototype-prediction-browser');
  await expect(browser).toBeVisible();
  await expect(browser).toContainText('Illustrative reference sequence');
  await expect(browser).toContainText('Illustrative model scores (+ / − strands)');
  await expect(page.locator('.portal-browser').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Top called peaks')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Top called peak' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Go to peak' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download GFF3' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download bedGraph' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/sigma|minimum peak distance/i);

  const stored = await storedPrototypeRuns(page);
  expect(stored).toHaveLength(1);
  expect(stored[0].value).not.toContain('ACGTACGTACGT');
  expect(stored[0].value).not.toMatch(/"(?:sequence|fasta)"\s*:/i);
  expect(JSON.parse(stored[0].value)).toMatchObject({
    schemaVersion: 3,
    mode: 'genome-scan',
    parameters: { strandMode: 'forward', cutoff: 0.8, strideBases: 10 },
    input: {
      kind: 'genome-scan',
      scanSource: { kind: 'catalog', accession: 'GCF_000005845.2', totalLength: 4_641_652 },
      genomeContext: { kind: 'upload', fileName: 'matching-context.fna', totalLength: 160 },
    },
  });
  expect(predictionRequests).toEqual([]);
});

test('a longer pasted sequence stays browser-local and falls back safely after reload', async ({ page }) => {
  const predictionRequests = capturePredictionApiRequests(page);
  const originalInput = `>browser_contig\n${'ACGT'.repeat(40)}\n>second_contig\n${'TGCA'.repeat(35)}`;

  await page.goto('/predict');
  await page.getByLabel('Raw DNA or FASTA').fill(originalInput);
  await expect(page.getByText('Sequence scan').first()).toBeVisible();
  await expect(page.getByLabel('Top results')).toHaveCount(0);
  await expect(page.getByText('Genome context required')).toBeVisible();
  await uploadCgrContext(page);

  await Promise.all([
    page.waitForURL(/\/predict\/demo\/prototype_/),
    page.getByRole('button', { name: 'Preview illustrative result' }).click(),
  ]);

  const browser = page.getByTestId('prototype-prediction-browser');
  await expect(page.getByRole('region', { name: 'Prediction progress' })).toBeVisible();
  await expect(browser).toContainText('Submitted reference sequence (this tab only)', { timeout: 12_000 });
  await expect(browser.getByRole('heading', { name: 'Browser tracks' })).toHaveCount(0);
  await expect(page.locator('.portal-browser').first()).toBeVisible({ timeout: 60_000 });

  const stored = await storedPrototypeRuns(page);
  expect(stored).toHaveLength(1);
  expect(stored[0].value).not.toContain(originalInput);
  expect(stored[0].value).not.toContain('browser_contig');
  expect(stored[0].value).not.toContain('ACGTACGTACGT');
  expect(predictionRequests).toEqual([]);

  await page.reload();
  await expect(page.getByTestId('prototype-prediction-browser')).toContainText('Illustrative reference sequence');
});

test('the scan browser remains usable at 768 px', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/predict');
  await page.getByRole('button', { name: 'Use E. coli K-12 genome example' }).click();
  await uploadCgrContext(page, 'tablet-context.fna');
  await Promise.all([
    page.waitForURL(/\/predict\/demo\/prototype_/),
    page.getByRole('button', { name: 'Preview illustrative result' }).click(),
  ]);

  await expect(page.getByTestId('prototype-prediction-browser')).toBeVisible({ timeout: 12_000 });
  await expect(page.getByRole('combobox', { name: 'Contig' })).toBeVisible();
  await expect(page.locator('.portal-browser').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Download GFF3' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download bedGraph' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test.describe('catalog failure and mobile focused result', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('preserves the focused input and reaches a result through context FASTA upload', async ({ page }) => {
    const predictionRequests = capturePredictionApiRequests(page);
    await page.route('**/api/genomes?**', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Catalog unavailable in this test.' }),
    }));

    await page.goto('/predict');
    await page.getByRole('button', { name: 'Use 100 bp example' }).click();
    const sequenceInput = page.getByLabel('Raw DNA or FASTA');
    const originalSequence = await sequenceInput.inputValue();
    await page.locator('#prototype-context-catalog-search').fill('Escherichia coli');
    await page.getByRole('button', { name: 'Search catalog' }).last().click();

    await expect(page.getByRole('alert').filter({ hasText: 'Your input is unchanged' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry search' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Help' })).toHaveCount(0);
    await expect(sequenceInput).toHaveValue(originalSequence);

    await page.getByRole('button', { name: 'Upload FASTA instead' }).click();
    await page.locator('input[type="file"]').last().setInputFiles({
      name: 'matching-context.fna',
      mimeType: 'text/plain',
      buffer: Buffer.from(`>matching_contig\n${'ACGT'.repeat(40)}\n`),
    });
    await expect(page.getByText('Genome context ready: Matching genome FASTA.')).toBeVisible();

    await Promise.all([
      page.waitForURL(/\/predict\/demo\/prototype_/),
      page.getByRole('button', { name: 'Preview illustrative result' }).click(),
    ]);
    await expect(page.getByRole('heading', { name: 'Prediction result' })).toBeVisible();
    await expect(page.getByRole('meter', { name: /Forward strand.*illustrative model score/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('100 bp anchor positions')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    const stored = await storedPrototypeRuns(page);
    expect(stored).toHaveLength(1);
    expect(stored[0].value).not.toContain(originalSequence);
    expect(stored[0].value).not.toContain('ACGTACGTACGT');
    expect(predictionRequests).toEqual([]);
  });
});
