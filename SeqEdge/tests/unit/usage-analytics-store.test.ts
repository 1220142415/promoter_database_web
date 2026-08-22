import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shiftDay, utcDay } from '@/lib/usage-analytics';

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }));

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

class FakeStatement {
  binds: unknown[] = [];

  constructor(private readonly database: FakeD1, readonly sql: string) {}

  bind(...values: unknown[]) {
    this.binds = values;
    return this;
  }

  async first<T>() {
    return (this.database.firstRow as T) ?? null;
  }

  async run() {
    this.database.statements.push({ sql: this.sql, binds: this.binds });
    return { results: [], success: true, meta: {} };
  }

  async all() {
    return { results: [], success: true, meta: {} };
  }
}

class FakeD1 {
  statements: RecordedStatement[] = [];
  batches: RecordedStatement[][] = [];
  firstRow: Record<string, unknown> | null = { salt: 'stored-daily-salt' };
  batchResults: Record<string, unknown>[][] = [];
  purgeFailures = 0;

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    const recorded = statements.map((statement) => ({ sql: statement.sql, binds: statement.binds }));
    const isPurge = recorded.every((statement) => statement.sql.startsWith('DELETE'));
    this.batches.push(recorded);
    this.statements.push(...recorded);
    if (isPurge && this.purgeFailures > 0) {
      this.purgeFailures -= 1;
      throw new Error('purge failed');
    }
    return statements.map(() => ({ results: isPurge ? [] : this.batchResults.shift() ?? [], success: true, meta: {} }));
  }
}

function pageRequest(pathname = '/genomes', headers: Record<string, string> = {}) {
  return {
    method: 'GET',
    nextUrl: { pathname },
    headers: new Headers({
      'sec-fetch-dest': 'document',
      'cf-connecting-ip': '203.0.113.5',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      ...headers,
    }),
  };
}

const settings = { enabled: true, precision: 'city' as const, retentionDays: 400, trustProxyHeaders: false };
const originalAnalytics = process.env.SEQEDGE_ANALYTICS;

let store: typeof import('@/lib/usage-analytics-store');

beforeEach(async () => {
  delete process.env.SEQEDGE_ANALYTICS;
  vi.resetModules();
  getCloudflareContext.mockReset();
  store = await import('@/lib/usage-analytics-store');
});

afterEach(() => {
  if (originalAnalytics === undefined) delete process.env.SEQEDGE_ANALYTICS;
  else process.env.SEQEDGE_ANALYTICS = originalAnalytics;
});

describe('recording a page view', () => {
  it('does not touch the runtime while analytics is not explicitly enabled', () => {
    store.scheduleUsageCollection(pageRequest());
    expect(getCloudflareContext).not.toHaveBeenCalled();
  });

  it('collects country-only data by default after explicit enablement', async () => {
    process.env.SEQEDGE_ANALYTICS = 'on';
    const database = new FakeD1();
    let backgroundTask: Promise<unknown> | undefined;
    getCloudflareContext.mockReturnValue({
      env: { SEQEDGE_DB: database },
      cf: { country: 'DE', region: 'Baden-Wurttemberg', city: 'Heidelberg' },
      ctx: { waitUntil: (task: Promise<unknown>) => { backgroundTask = task; } },
    });

    store.scheduleUsageCollection(pageRequest());
    await backgroundTask;

    expect(database.batches[0][1].binds.slice(1)).toEqual(['DE', '', '', null, null]);
  });

  it('writes the visitor token, the location and the path in one batch', async () => {
    const database = new FakeD1();
    await store.recordUsage(database as unknown as D1Database, pageRequest('/genomes/GCA_000411415.1'), { country: 'DE', city: 'Heidelberg', region: 'Baden-Wurttemberg', latitude: '49.41', longitude: '8.69' }, settings);

    const [visitor, geo, path] = database.batches[0];
    const day = utcDay();
    expect(visitor.sql).toContain('INSERT INTO analytics_visitor_day');
    expect(visitor.binds[0]).toBe(day);
    expect(String(visitor.binds[1])).toMatch(/^[0-9a-f]{32}$/);
    expect(visitor.binds.slice(2)).toEqual(['DE', 'Baden-Wurttemberg', 'Heidelberg']);
    expect(geo.sql).toContain('INSERT INTO analytics_daily_geo');
    expect(geo.binds).toEqual([day, 'DE', 'Baden-Wurttemberg', 'Heidelberg', 49.41, 8.69]);
    expect(path.sql).toContain('INSERT INTO analytics_daily_path');
    expect(path.binds).toEqual([day, '/genomes/[accession]']);
  });

  it('never sends the address or the user agent to the database', async () => {
    const database = new FakeD1();
    await store.recordUsage(database as unknown as D1Database, pageRequest(), { country: 'DE' }, settings);

    const written = JSON.stringify(database.statements);
    expect(written).not.toContain('203.0.113.5');
    expect(written).not.toContain('Mozilla');
  });

  it('reuses the stored daily salt so one visitor is counted once', async () => {
    const database = new FakeD1();
    await store.recordUsage(database as unknown as D1Database, pageRequest(), { country: 'DE' }, settings);
    const firstHash = database.batches[0][0].binds[1];

    await store.recordUsage(database as unknown as D1Database, pageRequest('/data'), { country: 'DE' }, settings);
    expect(database.batches[2][0].binds[1]).toBe(firstHash);
  });

  it('deletes expired rows once, and drops salts after two days', async () => {
    const database = new FakeD1();
    await store.recordUsage(database as unknown as D1Database, pageRequest(), { country: 'DE' }, { ...settings, retentionDays: 90 });
    await store.recordUsage(database as unknown as D1Database, pageRequest(), { country: 'DE' }, { ...settings, retentionDays: 90 });

    const purges = database.batches.filter((batch) => batch.some((statement) => statement.sql.startsWith('DELETE')));
    expect(purges).toHaveLength(1);
    expect(purges[0].map((statement) => statement.binds[0])).toEqual([
      shiftDay(utcDay(), -89),
      shiftDay(utcDay(), -89),
      shiftDay(utcDay(), -89),
      shiftDay(utcDay(), -1),
    ]);
  });

  it('retries retention cleanup after a failed purge', async () => {
    const database = new FakeD1();
    database.purgeFailures = 1;

    await expect(store.recordUsage(database as unknown as D1Database, pageRequest(), { country: 'DE' }, settings)).rejects.toThrow('purge failed');
    await expect(store.recordUsage(database as unknown as D1Database, pageRequest(), { country: 'DE' }, settings)).resolves.toBeUndefined();

    const purges = database.batches.filter((batch) => batch.every((statement) => statement.sql.startsWith('DELETE')));
    expect(purges).toHaveLength(2);
  });

  it('logs a fixed structured event when a background write fails', async () => {
    process.env.SEQEDGE_ANALYTICS = 'on';
    const database = new FakeD1();
    database.firstRow = null;
    const sensitiveError = new Error('203.0.113.5 Mozilla/5.0');
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith('INSERT INTO analytics_salt')) {
        statement.run = async () => { throw sensitiveError; };
      }
      return statement;
    });
    let backgroundTask: Promise<unknown> | undefined;
    getCloudflareContext.mockReturnValue({
      env: { SEQEDGE_DB: database },
      cf: { country: 'DE' },
      ctx: { waitUntil: (task: Promise<unknown>) => { backgroundTask = task; } },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    store.scheduleUsageCollection(pageRequest());
    await backgroundTask;

    expect(error).toHaveBeenCalledWith('{"event":"usage_analytics_write_failed"}');
    expect(JSON.stringify(error.mock.calls)).not.toContain('203.0.113.5');
    expect(JSON.stringify(error.mock.calls)).not.toContain('Mozilla');
  });
});

describe('reading the report', () => {
  it('merges views and visitors into ranked countries, cities, pages and days', async () => {
    const today = utcDay();
    const yesterday = shiftDay(today, -1);
    const database = new FakeD1();
    database.batchResults = [
      [{ country_code: 'DE', views: 40 }, { country_code: 'CN', views: 25 }, { country_code: 'XX', views: 5 }],
      [{ country_code: 'DE', visitors: 8 }, { country_code: 'CN', visitors: 6 }, { country_code: 'US', visitors: 2 }],
      [{ country_code: 'DE', region: 'Baden-Wurttemberg', city: 'Heidelberg', views: 30 }],
      [{ country_code: 'DE', region: 'Baden-Wurttemberg', city: 'Heidelberg', visitors: 5 }],
      [{ path: '/genomes', views: 50 }],
      [{ day: yesterday, views: 30 }, { day: today, views: 40 }],
      [{ day: today, visitors: 9 }],
      [{ first_day: '2026-08-01' }],
    ];

    const report = await store.readUsageReport(database as unknown as D1Database, 7);

    expect(report.totals).toEqual({ views: 70, visitors: 16, countries: 3, cities: 1, activeDays: 2 });
    expect(report.countries[0]).toMatchObject({ code: 'DE', name: 'Germany', visitors: 8, views: 40, share: 0.5 });
    expect(report.countries.find((country) => country.code === 'US')).toMatchObject({ visitors: 2, views: 0 });
    expect(report.cities[0]).toMatchObject({ city: 'Heidelberg', countryName: 'Germany', views: 30, visitors: 5 });
    expect(report.paths).toEqual([{ path: '/genomes', views: 50 }]);
    expect(report.daily).toHaveLength(7);
    expect(report.daily[0]).toEqual({ day: shiftDay(today, -6), views: 0, visitors: 0 });
    expect(report.daily.slice(-2)).toEqual([
      { day: yesterday, views: 30, visitors: 0 },
      { day: today, views: 40, visitors: 9 },
    ]);
    expect(report.firstRecordedDay).toBe('2026-08-01');
    expect(report.startDay).toBe(shiftDay(today, -6));
    expect(database.batches[0].every((statement) => statement.sql.startsWith('DELETE'))).toBe(true);
  });

  it('reports every recorded day when the range is all time', async () => {
    const firstDay = shiftDay(utcDay(), -20);
    const database = new FakeD1();
    database.batchResults = [[], [], [], [], [], [], [], [{ first_day: firstDay }]];

    const report = await store.readUsageReport(database as unknown as D1Database, 0);

    expect(report.startDay).toBe(firstDay);
    expect(report.totals.views).toBe(0);
    expect(report.daily).toHaveLength(21);
    expect(database.batches[1][0].binds[0]).toBe('0000-01-01');
  });

  it('enforces retention when the protected report is read without traffic', async () => {
    const database = new FakeD1();
    database.batchResults = [[], [], [], [], [], [], [], []];

    await store.readUsageReport(database as unknown as D1Database, 30);

    const purge = database.batches[0];
    expect(purge.map((statement) => statement.binds[0])).toEqual([
      shiftDay(utcDay(), -399),
      shiftDay(utcDay(), -399),
      shiftDay(utcDay(), -399),
      shiftDay(utcDay(), -1),
    ]);
  });
});
