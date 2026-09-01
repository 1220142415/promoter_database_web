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

test('100 bp example is inferred as Focused without submitting or storing raw sequence', async ({ page }) => {
  const predictionRequests = capturePredictionApiRequests(page);

  await page.goto('/predict');
  await expect(page.getByRole('heading', { name: 'Prepare one input. RAPPTOR infers the workflow.' })).toBeVisible();
  await expect(page.getByText('No model was run').first()).toBeVisible();
  await expect(page.getByRole('tab', { name: /Candidate region|Whole genome/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Use 100 bp example' }).click();

  const sequenceInput = page.getByLabel('Raw DNA or FASTA');
  await expect(sequenceInput).toHaveValue(/focused_candidate_100bp/);
  await expect(page.getByText('Focused candidate').first()).toBeVisible();
  await expect(page.getByText(/1 record · 100 bp/)).toBeVisible();
  await expect(page.getByText(/Escherichia coli str\. K-12/)).toBeVisible();
  await expect(page.getByLabel('Top results')).toHaveCount(0);

  await Promise.all([
    page.waitForURL(/\/predict\/demo\/prototype_/),
    page.getByRole('button', { name: 'Preview illustrative result' }).click(),
  ]);

  await expect(page.getByRole('heading', { name: 'Prediction result' })).toBeVisible();
  await expect(page.getByText('Focused 100 bp scoring')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Focused 100 bp raw scores' })).toBeVisible();
  await expect(page.getByText('Anchor +80')).toBeVisible();
  await expect(page.getByText('Anchor −21')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/raw score curve|top windows|called peak|top results/i);
  await expect(page.getByRole('link', { name: 'Read the interpretation guide' })).toHaveAttribute('href', '/help/prediction#results');

  const stored = await storedPrototypeRuns(page);
  expect(stored).toHaveLength(1);
  expect(stored[0].value).not.toContain('focused_candidate_100bp');
  expect(stored[0].value).not.toContain('ACGTACGTACGT');
  expect(stored[0].value).not.toMatch(/"(?:sequence|fasta)"\s*:/i);
  const payload = JSON.parse(stored[0].value);
  expect(payload).toMatchObject({
    schemaVersion: 2,
    mode: 'candidate',
    parameters: { strandMode: 'both', cutoff: 0.9 },
    input: { kind: 'candidate', length: 100, checksum: expect.any(String) },
  });
  expect(payload.parameters).not.toHaveProperty('topK');
  expect(predictionRequests).toEqual([]);
});

test('multi-contig example is inferred as Scan with public controls only', async ({ page }) => {
  const predictionRequests = capturePredictionApiRequests(page);

  await page.goto('/predict');
  await page.getByRole('button', { name: 'Use contig example' }).click();
  await expect(page.getByText('Genome scan').first()).toBeVisible();
  await expect(page.getByText(/1 short contig skipped/)).toBeVisible();
  await page.getByLabel('Strands').selectOption('forward');
  await page.getByLabel('Score cutoff').fill('0.80');
  await page.getByLabel('Top results').selectOption('5');

  await expect(page.getByText(/Peak calling uses backend-managed settings/)).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/sigma|minimum peak distance/i);

  await Promise.all([
    page.waitForURL(/\/predict\/demo\/prototype_/),
    page.getByRole('button', { name: 'Preview illustrative result' }).click(),
  ]);

  await expect(page.getByRole('heading', { name: 'Prediction result' })).toBeVisible();
  await expect(page.getByText('Whole genome / contigs scan')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Raw scores and called peaks' })).toBeVisible();
  await expect(page.getByRole('img', { name: /inline_contig_1/ })).toBeVisible();
  await expect(page.getByRole('img', { name: /inline_contig_2/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Parquet Live service only/ })).toBeDisabled();

  const stored = await storedPrototypeRuns(page);
  expect(stored).toHaveLength(1);
  expect(stored[0].value).not.toContain('tutorial_contig');
  expect(stored[0].value).not.toContain('ACGTACGTACGT');
  expect(stored[0].value).not.toMatch(/"(?:sequence|fasta)"\s*:/i);
  expect(JSON.parse(stored[0].value)).toMatchObject({
    schemaVersion: 2,
    mode: 'genome-scan',
    parameters: { strandMode: 'forward', cutoff: 0.8, topK: 5 },
    input: { kind: 'genome-scan', genomeContext: { kind: 'inline', totalLength: 380 } },
  });
  expect(predictionRequests).toEqual([]);
});

test.describe('catalog failure and mobile fallback', () => {
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
    await page.getByRole('button', { name: 'Change' }).click();
    await page.getByRole('combobox', { name: 'Accession, organism, or strain' }).fill('Escherichia coli');
    await page.getByRole('button', { name: 'Search catalog' }).click();

    await expect(page.getByRole('alert').filter({ hasText: 'Your other inputs are still here' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry search' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Help' })).toHaveAttribute('href', '/help/prediction#troubleshooting');
    await expect(sequenceInput).toHaveValue(originalSequence);

    await page.getByRole('button', { name: 'Upload FASTA instead' }).click();
    await page.locator('input[type="file"][accept*=".fa.gz"]').setInputFiles({
      name: 'matching-context.fna',
      mimeType: 'text/plain',
      buffer: Buffer.from(`>matching_contig\n${'ACGT'.repeat(40)}\n`),
    });
    await expect(page.getByRole('button', { name: /matching-context\.fna/ })).toBeVisible();

    await Promise.all([
      page.waitForURL(/\/predict\/demo\/prototype_/),
      page.getByRole('button', { name: 'Preview illustrative result' }).click(),
    ]);
    await expect(page.getByRole('heading', { name: 'Prediction result' })).toBeVisible();
    await expect(page.getByText('Anchor +80')).toBeVisible();
    await expect(page.getByText('Anchor −21')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    const stored = await storedPrototypeRuns(page);
    expect(stored).toHaveLength(1);
    expect(stored[0].value).not.toContain(originalSequence);
    expect(stored[0].value).not.toContain('ACGTACGTACGT');
    expect(predictionRequests).toEqual([]);
  });
});
