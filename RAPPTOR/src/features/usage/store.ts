// D1 persistence for the usage counter. Writes happen from the middleware on a
// background task, reads serve the admin dashboard. Imported by the middleware,
// so it must stay free of Node-only APIs.

import { getCloudflareContext } from '@opennextjs/cloudflare';

import {
  countryFlag,
  countryName,
  deriveVisitorHash,
  isCountablePageRequest,
  isLikelyBot,
  normalizePath,
  readUsageSettings,
  resolveClientAddress,
  resolveGeo,
  shiftDay,
  UNKNOWN_COUNTRY,
  utcDay,
} from '@/features/usage/analytics';
import type { CloudflareGeoProperties, UsageEvent } from '@/features/usage/analytics';
import type {
  UsageCityRow,
  UsageCountryRow,
  UsageDayRow,
  UsagePathRow,
  UsageReport,
} from '@/features/usage/types';

interface UsageRuntime {
  env: CloudflareEnv;
  cf: CloudflareGeoProperties | undefined;
  ctx: { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
}

interface CountableRequest {
  method: string;
  nextUrl: { pathname: string };
  headers: { get(name: string): string | null };
}

const TOP_CITIES = 25;
const TOP_PATHS = 20;
const MAX_SERIES_DAYS = 400;
const EARLIEST_DAY = '0000-01-01';
const SALT_RETENTION_DAYS = 2;

const RECORD_VISITOR_SQL = `INSERT INTO analytics_visitor_day (day, visitor_hash, country_code, region, city)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(day, visitor_hash) DO NOTHING`;

const RECORD_GEO_SQL = `INSERT INTO analytics_daily_geo (day, country_code, region, city, latitude, longitude, views)
  VALUES (?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(day, country_code, region, city) DO UPDATE SET
    views = views + 1,
    latitude = COALESCE(analytics_daily_geo.latitude, excluded.latitude),
    longitude = COALESCE(analytics_daily_geo.longitude, excluded.longitude)`;

const RECORD_PATH_SQL = `INSERT INTO analytics_daily_path (day, path, views)
  VALUES (?, ?, 1)
  ON CONFLICT(day, path) DO UPDATE SET views = views + 1`;

let cachedSalt: { day: string; salt: string } | null = null;
let lastPurgeDay: string | null = null;

export function usageRuntime(): UsageRuntime | null {
  try {
    return getCloudflareContext() as unknown as UsageRuntime;
  } catch {
    return null;
  }
}

export function usageDatabase(): D1Database | null {
  return usageRuntime()?.env.RAPPTOR_DB ?? null;
}

async function resolveSalt(database: D1Database, day: string) {
  if (cachedSalt?.day === day) return cachedSalt.salt;

  const salt = await resolveStoredSalt(database, day);
  cachedSalt = { day, salt };
  return salt;
}

async function resolveStoredSalt(database: D1Database, day: string) {
  const generated = crypto.randomUUID();
  await database
    .prepare('INSERT INTO analytics_salt (day, salt) VALUES (?, ?) ON CONFLICT(day) DO NOTHING')
    .bind(day, generated)
    .run();
  const row = await database.prepare('SELECT salt FROM analytics_salt WHERE day = ?').bind(day).first<{ salt: string }>();
  return row?.salt || generated;
}

/**
 * Deletes expired rows once per worker instance per day. Salts are dropped after
 * two days, which permanently unlinks the stored visitor tokens.
 */
async function purgeExpired(database: D1Database, day: string, retentionDays: number) {
  if (lastPurgeDay === day) return;
  // Today is the first retained date, so N days includes today plus N - 1
  // preceding UTC dates. Likewise, two salt dates means today and yesterday.
  const cutoff = shiftDay(day, -(retentionDays - 1));
  await database.batch([
    database.prepare('DELETE FROM analytics_visitor_day WHERE day < ?').bind(cutoff),
    database.prepare('DELETE FROM analytics_daily_geo WHERE day < ?').bind(cutoff),
    database.prepare('DELETE FROM analytics_daily_path WHERE day < ?').bind(cutoff),
    database.prepare('DELETE FROM analytics_salt WHERE day < ?').bind(shiftDay(day, -(SALT_RETENTION_DAYS - 1))),
  ]);
  lastPurgeDay = day;
}

export async function writeUsageEvent(database: D1Database, event: UsageEvent) {
  const { day, path, geo, visitorHash } = event;
  await database.batch([
    database.prepare(RECORD_VISITOR_SQL).bind(day, visitorHash, geo.countryCode, geo.region, geo.city),
    database.prepare(RECORD_GEO_SQL).bind(day, geo.countryCode, geo.region, geo.city, geo.latitude, geo.longitude),
    database.prepare(RECORD_PATH_SQL).bind(day, path),
  ]);
}

export async function recordUsage(
  database: D1Database,
  request: CountableRequest,
  cf: CloudflareGeoProperties | undefined,
  settings = readUsageSettings(),
  cloudflareRuntime = Boolean(cf),
) {
  const day = utcDay();
  const trust = { cloudflare: cloudflareRuntime, proxyHeaders: settings.trustProxyHeaders };
  const geo = resolveGeo(cloudflareRuntime ? cf : undefined, request.headers, settings.precision, trust);
  const salt = await resolveSalt(database, day);
  const visitorHash = await deriveVisitorHash(
    salt,
    resolveClientAddress(request.headers, trust),
    request.headers.get('user-agent'),
    geo.countryCode,
  );

  await writeUsageEvent(database, { day, path: normalizePath(request.nextUrl.pathname), geo, visitorHash });
  await purgeExpired(database, day, settings.retentionDays);
}

/**
 * Middleware entry point. Never throws and never delays the response: the write
 * runs on the Cloudflare background task queue after the response is sent.
 */
export function scheduleUsageCollection(request: CountableRequest) {
  const settings = readUsageSettings();
  if (!settings.enabled) return;
  if (!isCountablePageRequest(request)) return;
  if (isLikelyBot(request.headers.get('user-agent'))) return;

  const runtime = usageRuntime();
  const database = runtime?.env.RAPPTOR_DB;
  if (!runtime || !database) return;

  const task = recordUsage(database, request, runtime.cf, settings, true).catch(() => {
    // Do not include the error, request, headers, address or user agent here:
    // database errors can echo bound values and must not become a second log.
    console.error(JSON.stringify({ event: 'usage_analytics_write_failed' }));
  });
  if (runtime.ctx?.waitUntil) runtime.ctx.waitUntil(task);
}

function toNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toText(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function geoKey(countryCode: string, region: string, city: string) {
  return countryCode + '|' + region + '|' + city;
}

/**
 * Fills every day of the range, quiet ones included, so a week without visitors
 * reads as a gap in the trend instead of being compressed out of the axis.
 */
function buildDailySeries(startDay: string, endDay: string, views: Map<string, number>, visitors: Map<string, number>): UsageDayRow[] {
  const series: UsageDayRow[] = [];
  for (let day = startDay; day <= endDay && series.length < MAX_SERIES_DAYS; day = shiftDay(day, 1)) {
    series.push({ day, views: views.get(day) ?? 0, visitors: visitors.get(day) ?? 0 });
  }
  if (series.length < MAX_SERIES_DAYS) return series;

  // A wider window than retention allows would draw an unreadable chart, so
  // report the recorded days alone rather than a truncated range.
  return [...views.keys()].sort().map((day) => ({ day, views: views.get(day) ?? 0, visitors: visitors.get(day) ?? 0 }));
}

export async function readUsageReport(database: D1Database, rangeDays: number): Promise<UsageReport> {
  const endDay = utcDay();
  const startDay = rangeDays > 0 ? shiftDay(endDay, -(rangeDays - 1)) : EARLIEST_DAY;

  // Reading the protected dashboard is also an opportunity to enforce
  // retention on otherwise quiet deployments.
  await purgeExpired(database, endDay, readUsageSettings().retentionDays);

  const [
    countryViews,
    countryVisitors,
    cityViews,
    cityVisitors,
    paths,
    dailyViews,
    dailyVisitors,
    boundary,
  ] = await database.batch([
    database.prepare('SELECT country_code, SUM(views) AS views FROM analytics_daily_geo WHERE day >= ? GROUP BY country_code').bind(startDay),
    database.prepare('SELECT country_code, COUNT(*) AS visitors FROM analytics_visitor_day WHERE day >= ? GROUP BY country_code').bind(startDay),
    database.prepare(`SELECT country_code, region, city, SUM(views) AS views
      FROM analytics_daily_geo WHERE day >= ? AND city <> ''
      GROUP BY country_code, region, city ORDER BY views DESC LIMIT ?`).bind(startDay, TOP_CITIES),
    database.prepare(`SELECT country_code, region, city, COUNT(*) AS visitors
      FROM analytics_visitor_day WHERE day >= ? AND city <> ''
      GROUP BY country_code, region, city ORDER BY visitors DESC LIMIT ?`).bind(startDay, TOP_CITIES * 2),
    database.prepare('SELECT path, SUM(views) AS views FROM analytics_daily_path WHERE day >= ? GROUP BY path ORDER BY views DESC LIMIT ?').bind(startDay, TOP_PATHS),
    database.prepare('SELECT day, SUM(views) AS views FROM analytics_daily_geo WHERE day >= ? GROUP BY day ORDER BY day').bind(startDay),
    database.prepare('SELECT day, COUNT(*) AS visitors FROM analytics_visitor_day WHERE day >= ? GROUP BY day ORDER BY day').bind(startDay),
    database.prepare('SELECT MIN(day) AS first_day FROM analytics_daily_geo'),
  ]);

  const visitorsByCountry = new Map<string, number>();
  for (const row of countryVisitors.results) visitorsByCountry.set(toText(row.country_code), toNumber(row.visitors));

  const totalViews = countryViews.results.reduce((sum, row) => sum + toNumber(row.views), 0);
  const totalVisitors = [...visitorsByCountry.values()].reduce((sum, value) => sum + value, 0);

  const countries: UsageCountryRow[] = countryViews.results
    .map((row) => {
      const code = toText(row.country_code) || UNKNOWN_COUNTRY;
      const visitors = visitorsByCountry.get(code) ?? 0;
      visitorsByCountry.delete(code);
      return {
        code,
        name: countryName(code),
        flag: countryFlag(code),
        views: toNumber(row.views),
        visitors,
        share: totalVisitors > 0 ? visitors / totalVisitors : 0,
      };
    })
    .concat([...visitorsByCountry.entries()].map(([code, visitors]) => ({
      code,
      name: countryName(code),
      flag: countryFlag(code),
      views: 0,
      visitors,
      share: totalVisitors > 0 ? visitors / totalVisitors : 0,
    })))
    .sort((left, right) => right.visitors - left.visitors || right.views - left.views || left.code.localeCompare(right.code));

  const visitorsByCity = new Map<string, number>();
  for (const row of cityVisitors.results) {
    visitorsByCity.set(geoKey(toText(row.country_code), toText(row.region), toText(row.city)), toNumber(row.visitors));
  }

  const cities: UsageCityRow[] = cityViews.results.map((row) => {
    const countryCode = toText(row.country_code) || UNKNOWN_COUNTRY;
    const region = toText(row.region);
    const city = toText(row.city);
    return {
      countryCode,
      countryName: countryName(countryCode),
      region,
      city,
      views: toNumber(row.views),
      visitors: visitorsByCity.get(geoKey(countryCode, region, city)) ?? 0,
    };
  });

  const visitorsByDay = new Map<string, number>();
  for (const row of dailyVisitors.results) visitorsByDay.set(toText(row.day), toNumber(row.visitors));

  const viewsByDay = new Map<string, number>();
  for (const row of dailyViews.results) viewsByDay.set(toText(row.day), toNumber(row.views));

  const firstRecordedDay = toText(boundary.results[0]?.first_day) || null;
  const seriesStart = rangeDays > 0 ? startDay : firstRecordedDay || endDay;
  const daily = buildDailySeries(seriesStart, endDay, viewsByDay, visitorsByDay);
  const activeDays = daily.filter((entry) => entry.views > 0).length;

  const pathRows: UsagePathRow[] = paths.results.map((row) => ({ path: toText(row.path), views: toNumber(row.views) }));

  return {
    rangeDays,
    startDay: rangeDays > 0 ? startDay : firstRecordedDay || endDay,
    endDay,
    firstRecordedDay,
    totals: {
      views: totalViews,
      visitors: totalVisitors,
      countries: countries.filter((country) => country.code !== UNKNOWN_COUNTRY).length,
      cities: cities.length,
      activeDays,
    },
    countries,
    cities,
    paths: pathRows,
    daily,
  };
}
