// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UsageWorldMap from '@/features/usage/components/usage-world-map';
import type { UsageReport } from '@/features/usage/types';

const readUsageReport = vi.fn();
const usageDatabase = vi.fn(() => ({}) as unknown as D1Database);
const readUsageSettings = vi.fn(() => ({ enabled: true, precision: 'country' as const, retentionDays: 400 }));

vi.mock('@/features/usage/store', () => ({
  readUsageReport: (...args: unknown[]) => readUsageReport(...args),
  usageDatabase: () => usageDatabase(),
}));

vi.mock('@/features/usage/analytics', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/usage/analytics')>(),
  readUsageSettings: () => readUsageSettings(),
}));

vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}));

const report: UsageReport = {
  rangeDays: 30,
  startDay: '2026-07-23',
  endDay: '2026-08-21',
  firstRecordedDay: '2026-07-01',
  totals: { views: 70, visitors: 16, countries: 2, cities: 1, activeDays: 2 },
  countries: [
    { code: 'DE', name: 'Germany', flag: '🇩🇪', views: 40, visitors: 8, share: 0.5 },
    { code: 'CN', name: 'China', flag: '🇨🇳', views: 25, visitors: 6, share: 0.375 },
    { code: 'XX', name: 'Unknown', flag: '🏳️', views: 5, visitors: 2, share: 0.125 },
  ],
  cities: [{ countryCode: 'DE', countryName: 'Germany', region: 'Baden-Wurttemberg', city: 'Heidelberg', views: 30, visitors: 5 }],
  paths: [{ path: '/genomes/[accession]', views: 50 }],
  genomes: [{ accession: 'GCA_000411415.1', path: '/genomes/GCA_000411415.1', views: 50 }],
  daily: [
    { day: '2026-08-20', views: 30, visitors: 7 },
    { day: '2026-08-21', views: 40, visitors: 9 },
  ],
};

const originalEnv = {
  username: process.env.RAPPTOR_ANALYTICS_USERNAME,
  password: process.env.RAPPTOR_ANALYTICS_PASSWORD,
  publicPage: process.env.RAPPTOR_USAGE_PUBLIC_PAGE,
};

beforeEach(() => {
  process.env.RAPPTOR_ANALYTICS_USERNAME = 'curator';
  process.env.RAPPTOR_ANALYTICS_PASSWORD = 'usage-password';
  readUsageReport.mockResolvedValue(report);
  usageDatabase.mockReturnValue({} as unknown as D1Database);
  readUsageSettings.mockReturnValue({ enabled: true, precision: 'country', retentionDays: 400 });
});

afterEach(() => {
  if (originalEnv.username === undefined) delete process.env.RAPPTOR_ANALYTICS_USERNAME;
  else process.env.RAPPTOR_ANALYTICS_USERNAME = originalEnv.username;
  if (originalEnv.password === undefined) delete process.env.RAPPTOR_ANALYTICS_PASSWORD;
  else process.env.RAPPTOR_ANALYTICS_PASSWORD = originalEnv.password;
  if (originalEnv.publicPage === undefined) delete process.env.RAPPTOR_USAGE_PUBLIC_PAGE;
  else process.env.RAPPTOR_USAGE_PUBLIC_PAGE = originalEnv.publicPage;
});

async function renderDashboard(days?: string) {
  const { default: UsageDashboardPage } = await import('@/app/admin/usage/page');
  render(await UsageDashboardPage({ searchParams: Promise.resolve(days ? { days } : {}) }));
}

async function renderPublicDashboard(days?: string) {
  const { default: PublicUsagePage } = await import('@/app/usage/page');
  render(await PublicUsagePage({ searchParams: Promise.resolve(days ? { days } : {}) }));
}

describe('usage dashboard', () => {
  it('summarises visitors and locations without a pages module', async () => {
    await renderDashboard('7');

    expect(screen.getByRole('heading', { level: 1, name: 'Who is using RAPPTOR' })).toBeInTheDocument();
    expect(readUsageReport).toHaveBeenCalledWith(expect.anything(), 7);
    expect(screen.getByText('16')).toBeInTheDocument();
    expect(screen.getByText('70')).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Germany' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /Heidelberg/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pages' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: /World map shading 2 countries or regions by visitors/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Countries / regions' })).toBeInTheDocument();
  });

  it('shows ranked popular genomes without exposing request counts', async () => {
    await renderDashboard('7');

    const panel = screen.getByRole('heading', { name: 'Popular genomes' }).closest('section');
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).getByRole('link', { name: 'GCA_000411415.1' })).toHaveAttribute('href', '/genomes/GCA_000411415.1');
    expect(within(panel as HTMLElement).queryByText('50')).not.toBeInTheDocument();
  });

  it('plots daily visitors without page views', async () => {
    await renderDashboard('7');

    expect(screen.getByRole('img', { name: /Daily visitors from/ })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /page views/i })).not.toBeInTheDocument();
    expect(screen.getByText('2026-08-21: 9 visitors')).toBeInTheDocument();
  });

  it('offers CSV and JSON exports for the selected range', async () => {
    await renderDashboard('90');
    expect(screen.getByRole('link', { name: 'Download CSV' })).toHaveAttribute('href', '/api/admin/usage?days=90&format=csv');
    expect(screen.getByRole('link', { name: 'View JSON' })).toHaveAttribute('href', '/api/admin/usage?days=90');
  });

  it('describes opt-in collection and approximate daily visitors accurately', async () => {
    readUsageSettings.mockReturnValue({ enabled: false, precision: 'country', retentionDays: 400 });
    delete process.env.RAPPTOR_ANALYTICS;
    await renderDashboard();

    expect(screen.getByRole('heading', { name: 'Collection is switched off' }).parentElement).toHaveTextContent(
      'Set RAPPTOR_ANALYTICS=on to start counting',
    );
    expect(screen.getByText(/Approximate daily uniques, summed over the range/)).toBeInTheDocument();
    expect(screen.getByText(/random daily salt/)).toBeInTheDocument();
    expect(screen.getByText(/next successful counted request or dashboard read/)).toBeInTheDocument();
  });

  it('explains what to do when D1 is not bound', async () => {
    usageDatabase.mockReturnValue(null as unknown as D1Database);
    await renderDashboard();
    expect(screen.getByRole('heading', { name: 'No D1 binding' })).toBeInTheDocument();
  });

  it('explains that the migration is missing when the tables cannot be read', async () => {
    readUsageReport.mockRejectedValue(new Error('no such table: analytics_daily_geo'));
    await renderDashboard();
    expect(screen.getByRole('heading', { name: 'Usage tables unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/no such table/)).toBeInTheDocument();
  });

  it('stays hidden when no dashboard credentials are configured', async () => {
    delete process.env.RAPPTOR_ANALYTICS_USERNAME;
    delete process.env.RAPPTOR_ANALYTICS_PASSWORD;
    await expect(renderDashboard()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('offers a separately switchable read-only public report', async () => {
    process.env.RAPPTOR_USAGE_PUBLIC_PAGE = 'on';
    await renderPublicDashboard('7');

    expect(screen.getByRole('heading', { level: 1, name: 'Who is using RAPPTOR' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '30 days' })).toHaveAttribute('href', '/usage?days=30');
    expect(screen.queryByRole('link', { name: 'Download CSV' })).not.toBeInTheDocument();
  });

  it('returns not found when the public report switch is off', async () => {
    delete process.env.RAPPTOR_USAGE_PUBLIC_PAGE;
    await expect(renderPublicDashboard()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('usage world map', () => {
  it('shades measured countries and labels every country for hover', () => {
    const { container } = render(<UsageWorldMap countries={report.countries} />);

    const measured = container.querySelectorAll('.usage-map-country.is-measured');
    expect(measured).toHaveLength(2);
    expect(container.querySelector('title')?.textContent).toBeTruthy();
    expect([...container.querySelectorAll('title')].some((node) => node.textContent === 'Germany: 8 visitors, 40 page views')).toBe(true);
    expect([...container.querySelectorAll('title')].some((node) => node.textContent?.includes('no recorded visits'))).toBe(true);
  });

  it('renders an empty map without visits', () => {
    const { container } = render(<UsageWorldMap countries={[]} />);
    expect(screen.getByRole('img', { name: /World map shading 0 countries or regions/ })).toBeInTheDocument();
    expect(screen.getByText('No visitors yet')).toBeInTheDocument();
    expect([...container.querySelectorAll('title')].some((node) => node.textContent === 'Taiwan, China: no recorded visits')).toBe(true);
  });

  it('labels a Taiwan city as Taiwan, China without repeating Taiwan', async () => {
    readUsageReport.mockResolvedValue({
      ...report,
      cities: [{ countryCode: 'TW', countryName: 'Taiwan, China', region: 'Taiwan', city: 'Taichung', views: 2, visitors: 2 }],
    });
    await renderDashboard('7');

    expect(screen.getByRole('rowheader', { name: 'Taichung Taiwan, China' })).toBeInTheDocument();
    expect(screen.queryByText('Taiwan, Taiwan, China')).not.toBeInTheDocument();
  });

  it('includes Singapore and Japan in the generated map', () => {
    const countries = [
      { code: 'JP', name: 'Japan', flag: '🇯🇵', views: 4, visitors: 4, share: 0.8 },
      { code: 'SG', name: 'Singapore', flag: '🇸🇬', views: 1, visitors: 1, share: 0.2 },
    ];
    const { container } = render(<UsageWorldMap countries={countries} />);

    expect(container.querySelectorAll('.usage-map-country.is-measured')).toHaveLength(2);
    expect([...container.querySelectorAll('title')].some((node) => node.textContent === 'Singapore: 1 visitors, 1 page views')).toBe(true);
  });

  it('labels Taiwan as part of China', () => {
    const countries = [
      { code: 'TW', name: 'Taiwan, China', flag: '🇹🇼', views: 3, visitors: 2, share: 1 },
    ];
    const { container } = render(<UsageWorldMap countries={countries} />);

    expect([...container.querySelectorAll('title')].some((node) => node.textContent === 'Taiwan, China: 2 visitors, 3 page views')).toBe(true);
  });

  it('labels Hong Kong and Macao as part of China', () => {
    const countries = [
      { code: 'HK', name: 'Hong Kong, China', flag: '🇭🇰', views: 3, visitors: 2, share: 2 / 3 },
      { code: 'MO', name: 'Macao, China', flag: '🇲🇴', views: 1, visitors: 1, share: 1 / 3 },
    ];
    const { container } = render(<UsageWorldMap countries={countries} />);

    expect([...container.querySelectorAll('title')].some((node) => node.textContent === 'Hong Kong, China: 2 visitors, 3 page views')).toBe(true);
    expect([...container.querySelectorAll('title')].some((node) => node.textContent === 'Macao, China: 1 visitors, 1 page views')).toBe(true);
  });
});
