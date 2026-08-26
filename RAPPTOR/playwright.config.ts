import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const localPort = process.env.RAPPTOR_E2E_PORT || '3100';
const localBaseUrl = `http://127.0.0.1:${localPort}`;
const baseURL = externalBaseUrl || localBaseUrl;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: externalBaseUrl ? undefined : {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${localPort}`,
    env: {
      // The default suite deliberately exercises the deployment-safe state:
      // no analytics credentials and no analytics collection. A real D1
      // integration run must use an explicit external Cloudflare preview.
      RAPPTOR_ANALYTICS: 'off',
      RAPPTOR_ANALYTICS_PASSWORD: '',
      RAPPTOR_ANALYTICS_USERNAME: '',
      // Forward an explicitly selected local release into the managed server.
      // Empty values preserve the application's normal generated-catalog
      // fallback without committing a workstation-specific absolute path.
      LOCAL_CATALOG_PATH: process.env.LOCAL_CATALOG_PATH || '',
      LOCAL_DATA_ROOT: process.env.LOCAL_DATA_ROOT || '',
      LOCAL_RELEASE_ROOT: process.env.LOCAL_RELEASE_ROOT || '',
      EXPERIMENTAL_TSS_CATALOG_PATH: process.env.EXPERIMENTAL_TSS_CATALOG_PATH
        || resolve(process.cwd(), 'tests/e2e/fixtures/experimental-tss/catalog.json'),
      EXPERIMENTAL_TSS_STORAGE_BASE_URL: process.env.EXPERIMENTAL_TSS_STORAGE_BASE_URL
        || 'https://assets.invalid/releases/experimental-test',
    },
    url: localBaseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
