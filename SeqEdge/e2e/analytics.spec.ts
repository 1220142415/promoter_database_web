import { expect, test, type APIRequestContext } from '@playwright/test';

interface UsageReport {
  totals: {
    views: number;
    visitors: number;
  };
  paths: Array<{
    path: string;
    views: number;
  }>;
}

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const analyticsIntegrationEnabled = process.env.PLAYWRIGHT_ANALYTICS_E2E === 'on';
const analyticsUsername = process.env.PLAYWRIGHT_ANALYTICS_USERNAME;
const analyticsPassword = process.env.PLAYWRIGHT_ANALYTICS_PASSWORD;

function basicAuthorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function usageReport(request: APIRequestContext, authorization: string) {
  const response = await request.get('/api/admin/usage?days=7', {
    headers: { authorization },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<UsageReport>;
}

test.describe('analytics safety gates', () => {
  test('keeps admin routes hidden without credentials and leaves public pages available', async ({ page, request }) => {
    test.skip(Boolean(externalBaseUrl), 'The no-credentials contract is isolated by the Playwright-managed server.');

    const adminPage = await request.get('/admin/usage', { maxRedirects: 0 });
    const adminApi = await request.get('/api/admin/usage', { maxRedirects: 0 });
    expect(adminPage.status()).toBe(404);
    expect(adminApi.status()).toBe(404);
    expect(adminPage.headers()['cache-control']).toContain('no-store');
    expect(adminApi.headers()['cache-control']).toContain('no-store');

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'SeqEdge' })).toBeVisible();
    await expect(page.getByLabel('Release statistics')).toBeVisible();
  });
});

test.describe('local Cloudflare D1 analytics integration', () => {
  test.skip(
    !analyticsIntegrationEnabled,
    'Set PLAYWRIGHT_ANALYTICS_E2E=on with an external local Cloudflare preview to run the D1 integration test.',
  );

  test('authenticates reports and records two views as one daily visitor', async ({ browser, request }) => {
    expect(externalBaseUrl, 'PLAYWRIGHT_BASE_URL must point to an isolated local Cloudflare preview.').toBeTruthy();
    expect(analyticsUsername, 'Set PLAYWRIGHT_ANALYTICS_USERNAME to the preview credential.').toBeTruthy();
    expect(analyticsPassword, 'Set PLAYWRIGHT_ANALYTICS_PASSWORD to the preview credential.').toBeTruthy();
    expect(
      ['127.0.0.1', 'localhost', '[::1]'],
      'The state-changing analytics integration test is restricted to a loopback preview.',
    ).toContain(new URL(externalBaseUrl as string).hostname);

    const username = analyticsUsername as string;
    const password = analyticsPassword as string;
    const authorization = basicAuthorization(username, password);

    const hiddenResponse = await request.get('/api/admin/usage', { maxRedirects: 0 });
    const wrongPasswordResponse = await request.get('/api/admin/usage', {
      headers: { authorization: basicAuthorization(username, `${password}-wrong`) },
      maxRedirects: 0,
    });
    expect(hiddenResponse.status()).toBe(401);
    expect(wrongPasswordResponse.status()).toBe(401);
    expect(hiddenResponse.headers()['www-authenticate']).toContain('Basic realm="SeqEdge usage"');

    const before = await usageReport(request, authorization);
    const beforeRootViews = before.paths.find((entry) => entry.path === '/')?.views ?? 0;

    const visitorContext = await browser.newContext({
      baseURL: externalBaseUrl,
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 SeqEdgeValidation/${Date.now()}`,
    });
    const visitorPage = await visitorContext.newPage();
    await visitorPage.goto('/');
    await expect(visitorPage.getByRole('heading', { name: 'SeqEdge' })).toBeVisible();
    await visitorPage.reload();
    await expect(visitorPage.getByRole('heading', { name: 'SeqEdge' })).toBeVisible();
    await visitorContext.close();

    await expect.poll(async () => {
      const report = await usageReport(request, authorization);
      return report.paths.find((entry) => entry.path === '/')?.views ?? 0;
    }, { timeout: 20_000 }).toBe(beforeRootViews + 2);

    const after = await usageReport(request, authorization);
    expect(after.totals.views).toBe(before.totals.views + 2);
    expect(after.totals.visitors).toBe(before.totals.visitors + 1);

    for (const dataset of ['countries', 'cities', 'paths', 'daily']) {
      const csv = await request.get(`/api/admin/usage?days=7&format=csv&dataset=${dataset}`, {
        headers: { authorization },
      });
      expect(csv.status()).toBe(200);
      expect(csv.headers()['content-type']).toContain('text/csv');
      expect(csv.headers()['cache-control']).toContain('no-store');
      expect((await csv.text()).trim()).not.toBe('');
    }
  });
});
