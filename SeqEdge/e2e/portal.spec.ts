import { expect, test } from '@playwright/test';

test('home renders release aggregates without legacy bulk API requests', async ({ page }) => {
  const legacyRequests: string[] = [];
  const genomeAssetRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(stats|genomes|promoters|samples)(?:[/?]|$)/.test(request.url())) legacyRequests.push(request.url());
    if (request.url().includes('/api/local-data/')) genomeAssetRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'SeqEdge' })).toBeVisible();
  await expect(page.getByLabel('Release statistics')).toContainText('1,000');
  expect(legacyRequests).toEqual([]);
  expect(genomeAssetRequests).toEqual([]);
});

test('catalog search opens genomes with and without NCBI release assets', async ({ page }) => {
  const runtimeErrors: string[] = [];
  const catalogRequests: string[] = [];
  const catalogPageSizes: number[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/genomes') catalogRequests.push(request.url());
  });
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname !== '/api/genomes' || !response.ok()) return;
    const body = await response.json().catch(() => null) as { items?: unknown[] } | null;
    if (body) catalogPageSizes.push(body.items?.length ?? 0);
  });
  await page.goto('/genomes');
  const search = page.getByPlaceholder(/Search accession/);

  await search.fill('GCA_000411415.1');
  const annotatedGenome = page.getByRole('link', { name: 'GCA_000411415.1' });
  await expect(annotatedGenome).toBeVisible();
  await expect.poll(() => catalogPageSizes.length).toBeGreaterThan(0);
  expect(catalogRequests.some((url) => new URL(url).searchParams.get('q') === 'GCA_000411415.1')).toBe(true);
  expect(Math.max(...catalogPageSizes)).toBeLessThanOrEqual(100);
  await annotatedGenome.click();
  await expect(page.getByRole('heading', { name: 'Genome browser' })).toBeVisible();
  await expect(page.getByTestId('jbrowse-viewer')).toBeVisible();
  await expect(page.getByTestId('jbrowse-viewer')).toContainText('RAPPtor predicted promoter peaks');
  await expect(page.getByTestId('jbrowse-viewer')).toContainText('NCBI genome annotation');
  await expect(page.getByTestId('jbrowse-viewer')).not.toContainText('Object.defineProperty');
  await expect(page.getByRole('heading', { name: 'Downloads' })).toHaveCount(0);

  await page.goto('/genomes');
  await page.getByPlaceholder(/Search accession/).fill('GCA_000421325.1');
  const predictionOnlyGenome = page.getByRole('link', { name: 'GCA_000421325.1' });
  await expect(predictionOnlyGenome).toBeVisible();
  expect(catalogRequests.some((url) => new URL(url).searchParams.get('q') === 'GCA_000421325.1')).toBe(true);
  await predictionOnlyGenome.click();
  await expect(page.getByTestId('jbrowse-viewer')).toBeVisible();
  await expect(page.getByTestId('jbrowse-viewer')).toContainText('RAPPtor predicted promoter peaks');
  await expect(page.getByTestId('jbrowse-viewer')).not.toContainText('NCBI genome annotation');
  await expect(page.getByRole('heading', { name: 'Downloads' })).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test('feature sequence remains responsive after loading an NCBI gene', async ({ page }) => {
  const runtimeErrors: string[] = [];
  const referenceRequests: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (request.url().includes('/reference.fa.gz')) referenceRequests.push(request.url());
  });

  await page.goto('/genomes/GCA_000411415.1');
  await expect(page.getByTestId('jbrowse-viewer')).toContainText('NCBI genome annotation');
  await page.getByText('HMPREF1478_00003', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Feature details' })).toBeVisible();
  await expect(page.getByText('KE150450.1:3,704..5,231 (-)', { exact: true })).toBeVisible();
  await expect(page.getByText('1,528', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Show feature sequence' }).first().click();
  const hideSequence = page.getByRole('button', { name: 'Hide feature sequence' }).first();
  await expect(hideSequence).toBeVisible();
  await expect(page.getByText(/>HMPREF1478_00003-genomic KE150450\.1:3,704-5,231\(-\)/)).toBeVisible();

  const requestsAfterSequence = referenceRequests.length;
  await page.waitForTimeout(2_000);
  expect(referenceRequests.length).toBeLessThanOrEqual(requestsAfterSequence + 1);
  await hideSequence.click();
  await expect(page.getByRole('button', { name: 'Show feature sequence' }).first()).toBeVisible();
  expect(runtimeErrors.filter((error) => error.includes('Maximum update depth exceeded'))).toEqual([]);
});

test('catalog cascades taxonomy filters and sorts promoter counts in both directions', async ({ page }) => {
  await page.goto('/genomes');

  await page.getByLabel('Domain').selectOption('Bacteria');
  await page.getByLabel('Phylum').selectOption('Actinomycetota');
  await page.getByLabel('Class').selectOption('Actinomycetia');
  await page.getByLabel('Order').selectOption('Actinomycetales');
  await page.getByLabel('Family').selectOption('Actinomycetaceae');
  await page.getByLabel('Genus').selectOption('Pauljensenia');
  await expect(page.getByRole('status')).toContainText('1 genomes');
  await expect(page.getByRole('link', { name: 'GCA_000411415.1' })).toBeVisible();

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: /Predicted promoters/ }).click();
  await expect(page.getByRole('columnheader', { name: 'Predicted promoters' })).toHaveAttribute('aria-sort', 'descending');
  const descendingFirst = Number((await page.locator('tbody td.numeric-cell').first().innerText()).replaceAll(',', ''));

  await page.getByRole('button', { name: /Predicted promoters/ }).click();
  const ascendingFirst = Number((await page.locator('tbody td.numeric-cell').first().innerText()).replaceAll(',', ''));
  expect(ascendingFirst).toBeLessThan(descendingFirst);
});

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('opens, navigates, and closes from the menu button', async ({ page }) => {
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Open navigation' });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');
    await page.getByLabel('Primary navigation').getByRole('link', { name: 'Genomes' }).click();
    await expect(page).toHaveURL(/\/genomes$/);
    await expect(page.getByRole('heading', { name: 'Genome catalog' })).toBeVisible();
  });

  test('searches the catalog and opens an indexed genome on mobile', async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    await page.goto('/genomes');
    for (const label of ['Domain', 'Phylum', 'Class', 'Order', 'Family', 'Genus']) {
      await expect(page.getByLabel(label)).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /Accession/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByPlaceholder(/Search accession/).fill('GCA_000421325.1');
    await page.getByRole('link', { name: 'GCA_000421325.1' }).click();
    await expect(page.getByTestId('jbrowse-viewer')).toBeVisible();
    await expect(page.getByTestId('jbrowse-viewer')).toContainText('RAPPtor predicted promoter peaks');
    await expect(page.getByRole('heading', { name: 'Downloads' })).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);
  });
});
