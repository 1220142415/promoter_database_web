import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readUsageReport = vi.fn();
const usageDatabase = vi.fn();

vi.mock('@/lib/usage-analytics-store', () => ({
  readUsageReport: (...args: unknown[]) => readUsageReport(...args),
  usageDatabase: () => usageDatabase(),
}));

import { GET } from '@/app/api/admin/usage/route';
import type { UsageReport } from '@/types/usage-analytics';

const report: UsageReport = {
  rangeDays: 30,
  startDay: '2026-07-23',
  endDay: '2026-08-21',
  firstRecordedDay: '2026-07-01',
  totals: { views: 70, visitors: 16, countries: 2, cities: 1, activeDays: 2 },
  countries: [
    { code: 'DE', name: 'Germany', flag: '🇩🇪', views: 40, visitors: 8, share: 0.5 },
    { code: 'CN', name: 'China', flag: '🇨🇳', views: 25, visitors: 6, share: 0.375 },
  ],
  cities: [{ countryCode: 'DE', countryName: 'Germany', region: 'Baden-Wurttemberg', city: 'Heidelberg', views: 30, visitors: 5 }],
  paths: [{ path: '/genomes, all', views: 50 }],
  daily: [{ day: '2026-08-21', views: 40, visitors: 9 }],
};

const originalEnv = {
  username: process.env.SEQEDGE_ANALYTICS_USERNAME,
  password: process.env.SEQEDGE_ANALYTICS_PASSWORD,
};

beforeEach(() => {
  process.env.SEQEDGE_ANALYTICS_USERNAME = 'curator';
  process.env.SEQEDGE_ANALYTICS_PASSWORD = 'usage-password';
  readUsageReport.mockResolvedValue(report);
  usageDatabase.mockReturnValue({});
});

afterEach(() => {
  if (originalEnv.username === undefined) delete process.env.SEQEDGE_ANALYTICS_USERNAME;
  else process.env.SEQEDGE_ANALYTICS_USERNAME = originalEnv.username;
  if (originalEnv.password === undefined) delete process.env.SEQEDGE_ANALYTICS_PASSWORD;
  else process.env.SEQEDGE_ANALYTICS_PASSWORD = originalEnv.password;
});

describe('GET /api/admin/usage', () => {
  it('returns the report as JSON for an allowed range', async () => {
    const response = await GET(new Request('http://localhost/api/admin/usage?days=90'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(readUsageReport).toHaveBeenCalledWith(expect.anything(), 90);
    expect(await response.json()).toMatchObject({ totals: { views: 70 } });
  });

  it('falls back to 30 days for an unsupported range', async () => {
    await GET(new Request('http://localhost/api/admin/usage?days=13'));
    expect(readUsageReport).toHaveBeenCalledWith(expect.anything(), 30);
  });

  it('exports countries as CSV by default and quotes separators', async () => {
    const response = await GET(new Request('http://localhost/api/admin/usage?format=csv'));
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('seqedge-usage-countries-2026-07-23-to-2026-08-21.csv');
    expect(await response.text()).toBe([
      'country_code,country_name,visitors,views,share',
      'DE,Germany,8,40,0.5000',
      'CN,China,6,25,0.3750',
      '',
    ].join('\n'));
  });

  it('exports the requested dataset', async () => {
    const response = await GET(new Request('http://localhost/api/admin/usage?format=csv&dataset=paths'));
    expect(await response.text()).toBe('path,views\n"/genomes, all",50\n');
  });

  it('reports a missing D1 binding', async () => {
    usageDatabase.mockReturnValue(null);
    const response = await GET(new Request('http://localhost/api/admin/usage'));
    expect(response.status).toBe(503);
  });

  it('reports unreadable tables instead of failing', async () => {
    readUsageReport.mockRejectedValue(new Error('no such table: analytics_daily_geo'));
    const response = await GET(new Request('http://localhost/api/admin/usage'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('migration') });
  });

  it('stays hidden when no dashboard credentials are configured', async () => {
    delete process.env.SEQEDGE_ANALYTICS_USERNAME;
    delete process.env.SEQEDGE_ANALYTICS_PASSWORD;
    const response = await GET(new Request('http://localhost/api/admin/usage'));
    expect(response.status).toBe(404);
  });
});
