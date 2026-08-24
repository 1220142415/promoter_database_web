import { expect, test } from '@playwright/test';
import releaseSummary from '../../src/generated/release-summary.json';

test('home renders release aggregates without legacy bulk API requests', async ({ page }) => {
  const legacyRequests: string[] = [];
  const genomeAssetRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/(stats|genomes|promoters|samples)(?:[/?]|$)/.test(request.url())) legacyRequests.push(request.url());
    if (request.url().includes('/api/local-data/')) genomeAssetRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'RAPPTOR' })).toBeVisible();
  await expect(page.getByLabel('Release statistics')).toContainText(releaseSummary.totalGenomes.toLocaleString('en-US'));
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
  const waitForCatalogSearch = (accession: string) => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/genomes' && url.searchParams.get('q') === accession && response.ok();
  });

  await Promise.all([
    waitForCatalogSearch('GCA_000411415.1'),
    search.fill('GCA_000411415.1'),
  ]);
  const annotatedGenome = page.getByRole('link', { name: 'GCA_000411415.1' });
  await expect(annotatedGenome).toBeVisible();
  await expect.poll(() => catalogPageSizes.length).toBeGreaterThan(0);
  expect(catalogRequests.some((url) => new URL(url).searchParams.get('q') === 'GCA_000411415.1')).toBe(true);
  expect(Math.max(...catalogPageSizes)).toBeLessThanOrEqual(100);
  await Promise.all([
    page.waitForURL(/\/genomes\/GCA_000411415\.1$/),
    annotatedGenome.click(),
  ]);
  await expect(page.getByText('Assembly GCA_000411415.1', { exact: true })).toBeVisible();
  await expect(page.getByTestId('jbrowse-viewer')).toBeVisible();
  await expect(page.getByTestId('jbrowse-viewer')).toContainText('RAPPTOR predicted promoters');
  await expect(page.getByTestId('jbrowse-viewer')).toContainText('NCBI genome annotation');
  await expect(page.getByTestId('jbrowse-viewer')).not.toContainText('Object.defineProperty');
  await expect(page.getByRole('heading', { name: 'Downloads' })).toHaveCount(0);

  await page.goto('/genomes');
  await Promise.all([
    waitForCatalogSearch('GCA_000421325.1'),
    page.getByPlaceholder(/Search accession/).fill('GCA_000421325.1'),
  ]);
  const predictionOnlyGenome = page.getByRole('link', { name: 'GCA_000421325.1' });
  await expect(predictionOnlyGenome).toBeVisible();
  expect(catalogRequests.some((url) => new URL(url).searchParams.get('q') === 'GCA_000421325.1')).toBe(true);
  await Promise.all([
    page.waitForURL(/\/genomes\/GCA_000421325\.1$/),
    predictionOnlyGenome.click(),
  ]);
  await expect(page.getByTestId('jbrowse-viewer')).toBeVisible();
  await expect(page.getByTestId('jbrowse-viewer')).toContainText('RAPPTOR predicted promoters');
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
  await expect(page.getByText('KE150450.1:3,704..5,231 (-)', { exact: true }).first()).toBeVisible();
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

test('shared genome views preserve location, zoom, orientation, and track layout across viewport sizes', async ({ page, context }) => {
  test.setTimeout(60_000);
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
  });

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  const captureShareUrl = async () => {
    const shareButton = page.getByRole('button', { name: 'Share current view' });
    const fallbackInput = page.getByLabel('Share link');
    await expect(shareButton).toBeEnabled({ timeout: 30_000 });
    await shareButton.click();

    await expect.poll(async () => {
      if (await fallbackInput.count()) return 'manual';
      if (await page.getByText('Link copied', { exact: true }).count()) return 'clipboard';
      return 'waiting';
    }, { timeout: 10_000 }).not.toBe('waiting');

    const value = await fallbackInput.count()
      ? await fallbackInput.inputValue()
      : await page.evaluate(() => navigator.clipboard.readText());
    expect(value).not.toBe('');
    return new URL(value);
  };

  const expectShareContract = (url: URL) => {
    expect(url.pathname).toBe('/genomes/GCA_000411415.1');
    expect([...url.searchParams.keys()]).toEqual(['view', 'ref', 'center', 'zoom', 'rev', 'tracks']);
    expect(url.searchParams.get('view')).toBe('1');
    expect(url.searchParams.get('ref')).toBe('KE150450.1');
    expect(url.searchParams.get('rev')).toBe('1');
    expect(url.searchParams.get('tracks')).toBe('sequence:120,promoters:170,annotation:170');
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/genomes/GCA_000411415.1?view=1&ref=KE150450.1&center=4000&zoom=2&rev=1&tracks=sequence:120,promoters:170,annotation:170');
  await expect(page.getByTestId('jbrowse-viewer')).toBeVisible();
  const desktopShareUrl = await captureShareUrl();
  expectShareContract(desktopShareUrl);
  expect(Math.abs(Number(desktopShareUrl.searchParams.get('center')) - 4_000)).toBeLessThanOrEqual(1);
  expect(Number(desktopShareUrl.searchParams.get('zoom'))).toBeCloseTo(2, 9);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(desktopShareUrl.toString());
  await expect(page.getByTestId('jbrowse-viewer')).toBeVisible();
  const mobileShareUrl = await captureShareUrl();
  expectShareContract(mobileShareUrl);

  expect(mobileShareUrl.searchParams.get('ref')).toBe(desktopShareUrl.searchParams.get('ref'));
  expect(mobileShareUrl.searchParams.get('rev')).toBe(desktopShareUrl.searchParams.get('rev'));
  expect(mobileShareUrl.searchParams.get('tracks')).toBe(desktopShareUrl.searchParams.get('tracks'));
  expect(Math.abs(
    Number(mobileShareUrl.searchParams.get('center')) - Number(desktopShareUrl.searchParams.get('center')),
  )).toBeLessThanOrEqual(1);
  expect(Number(mobileShareUrl.searchParams.get('zoom'))).toBeCloseTo(
    Number(desktopShareUrl.searchParams.get('zoom')),
    9,
  );
  expect(runtimeErrors).toEqual([]);
});

test('catalog cascades taxonomy filters and sorts promoter counts in both directions', async ({ page }) => {
  await page.goto('/genomes');

  for (const [rank, value] of [
    ['Domain', 'Bacteria'],
    ['Phylum', 'Actinomycetota'],
    ['Class', 'Actinomycetia'],
    ['Order', 'Actinomycetales'],
    ['Family', 'Actinomycetaceae'],
    ['Genus', 'Pauljensenia'],
  ] as const) {
    const select = page.getByRole('combobox', { name: rank });
    await expect(select).toBeEnabled();
    await select.selectOption(value);
  }
  await expect(page.getByRole('status')).toContainText('1 genomes');
  await expect(page.getByRole('link', { name: 'GCA_000411415.1' })).toBeVisible();

  await page.getByRole('button', { name: 'Clear filters' }).click();
  const promoterSortButton = page.getByRole('button', { name: /Predicted promoters/ });
  const promoterSortResponse = (direction: 'asc' | 'desc') => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/genomes'
      && url.searchParams.get('sort') === 'promoters'
      && url.searchParams.get('direction') === direction
      && response.ok();
  });

  await Promise.all([promoterSortResponse('desc'), promoterSortButton.click()]);
  await expect(page.getByRole('columnheader', { name: 'Predicted promoters' })).toHaveAttribute('aria-sort', 'descending');
  const descendingFirst = Number((await page.locator('tbody td.numeric-cell').first().innerText()).replaceAll(',', ''));

  await Promise.all([promoterSortResponse('asc'), promoterSortButton.click()]);
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
      await expect(page.getByRole('combobox', { name: label })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /Accession/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/genomes' && url.searchParams.get('q') === 'GCA_000421325.1' && response.ok();
      }),
      page.getByPlaceholder(/Search accession/).fill('GCA_000421325.1'),
    ]);
    await Promise.all([
      page.waitForURL(/\/genomes\/GCA_000421325\.1$/),
      page.getByRole('link', { name: 'GCA_000421325.1' }).click(),
    ]);
    await expect(page.getByTestId('jbrowse-viewer')).toBeVisible();
    await expect(page.getByTestId('jbrowse-viewer')).toContainText('RAPPTOR predicted promoters');
    await expect(page.getByRole('heading', { name: 'Downloads' })).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);
  });
});
