// Request-shaping helpers for the privacy-preserving usage counter. This module
// is imported by the middleware, so it must stay free of Node-only APIs.

export type UsagePrecision = 'city' | 'country';

export interface UsageSettings {
  enabled: boolean;
  precision: UsagePrecision;
  retentionDays: number;
  salt: string | null;
}

export interface UsageGeo {
  countryCode: string;
  region: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
}

export interface UsageEvent {
  day: string;
  path: string;
  geo: UsageGeo;
  visitorHash: string;
}

export interface CloudflareGeoProperties {
  country?: string | null;
  city?: string | null;
  region?: string | null;
  regionCode?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
}

export const UNKNOWN_COUNTRY = 'XX';

const DEFAULT_RETENTION_DAYS = 400;
const MAX_PATH_SEGMENTS = 4;
const MAX_SEGMENT_LENGTH = 48;
const MAX_TEXT_LENGTH = 64;

const ACCESSION_PATTERN = /^GC[AF]_\d+\.\d+$/i;
const NUMERIC_PATTERN = /^\d+$/;
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;

// Skipped outright: none of these represent a person reading a page.
const NON_PAGE_PREFIXES = ['/api/', '/_next/', '/admin', '/cdn-cgi/'];
const NON_PAGE_EXTENSIONS = ['.ico', '.png', '.jpg', '.svg', '.webp', '.txt', '.xml', '.json', '.map', '.css', '.js'];

const BOT_PATTERN = /bot|crawl|spider|slurp|scrape|curl|wget|python-requests|httpx|axios|okhttp|java\/|go-http|libwww|headless|phantomjs|puppeteer|playwright|lighthouse|monitor|uptime|pingdom|preview|facebookexternalhit|embedly|feedfetcher|semrush|ahrefs|archive\.org/i;

function envValue(key: string): string | null {
  const value = process.env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isDisabledValue(value: string | null) {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === 'off' || normalized === '0' || normalized === 'false' || normalized === 'disabled';
}

export function readUsageSettings(): UsageSettings {
  const retention = Number(envValue('SEQEDGE_ANALYTICS_RETENTION_DAYS'));
  return {
    enabled: !isDisabledValue(envValue('SEQEDGE_ANALYTICS')),
    precision: envValue('SEQEDGE_ANALYTICS_PRECISION')?.toLowerCase() === 'country' ? 'country' : 'city',
    retentionDays: Number.isFinite(retention) && retention > 0 ? Math.floor(retention) : DEFAULT_RETENTION_DAYS,
    salt: envValue('SEQEDGE_ANALYTICS_SALT'),
  };
}

export function utcDay(date: Date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function shiftDay(day: string, offsetDays: number) {
  const date = new Date(day + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return utcDay(date);
}

export function isLikelyBot(userAgent: string | null) {
  if (!userAgent || userAgent.length < 8) return true;
  return BOT_PATTERN.test(userAgent);
}

/**
 * Only page views by a real reader are counted: no API traffic, no genome data
 * range requests, no router prefetches and no static asset requests.
 *
 * A full document load is the unit. Router navigations inside the app are RSC
 * fetches that carry the same headers as the prefetches Next.js fires for every
 * visible link, so counting them would inflate the numbers far more than
 * skipping them deflates them.
 */
export function isCountablePageRequest(request: {
  method: string;
  nextUrl: { pathname: string };
  headers: { get(name: string): string | null };
}) {
  if (request.method !== 'GET') return false;

  const pathname = request.nextUrl.pathname;
  if (NON_PAGE_PREFIXES.some((prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix))) return false;
  if (NON_PAGE_EXTENSIONS.some((extension) => pathname.endsWith(extension))) return false;

  const headers = request.headers;
  if (headers.get('next-router-prefetch')) return false;
  if (headers.get('purpose') === 'prefetch') return false;
  if (headers.get('sec-purpose')?.includes('prefetch')) return false;
  if (headers.get('x-nextjs-data')) return false;

  const destination = headers.get('sec-fetch-dest');
  if (destination) return destination === 'document';
  return headers.get('accept')?.includes('text/html') ?? false;
}

export function normalizePath(pathname: string) {
  const segments = pathname.split('/').filter(Boolean).slice(0, MAX_PATH_SEGMENTS).map((segment) => {
    if (ACCESSION_PATTERN.test(segment)) return '[accession]';
    if (NUMERIC_PATTERN.test(segment)) return '[id]';
    return segment.slice(0, MAX_SEGMENT_LENGTH);
  });
  return segments.length ? '/' + segments.join('/') : '/';
}

export function resolveClientAddress(headers: { get(name: string): string | null }) {
  const direct = headers.get('cf-connecting-ip') || headers.get('x-real-ip');
  if (direct?.trim()) return direct.trim();
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || null;
}

function cleanText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT_LENGTH) : '';
}

function coordinate(value: unknown) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function decodeHeaderText(value: string | null) {
  if (!value) return '';
  try { return cleanText(decodeURIComponent(value)); } catch { return cleanText(value); }
}

export function resolveGeo(
  cf: CloudflareGeoProperties | null | undefined,
  headers: { get(name: string): string | null },
  precision: UsagePrecision = 'city',
): UsageGeo {
  const headerCountry = headers.get('cf-ipcountry') || headers.get('x-vercel-ip-country') || headers.get('x-appengine-country');
  const rawCountry = cleanText(cf?.country) || cleanText(headerCountry);
  const countryCode = COUNTRY_PATTERN.test(rawCountry) ? rawCountry.toUpperCase() : UNKNOWN_COUNTRY;

  if (precision === 'country' || countryCode === UNKNOWN_COUNTRY) {
    return { countryCode, region: '', city: '', latitude: null, longitude: null };
  }

  return {
    countryCode,
    region: cleanText(cf?.region) || cleanText(cf?.regionCode) || decodeHeaderText(headers.get('x-vercel-ip-country-region')),
    city: cleanText(cf?.city) || decodeHeaderText(headers.get('x-vercel-ip-city')),
    latitude: coordinate(cf?.latitude),
    longitude: coordinate(cf?.longitude),
  };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deriveDailySalt(secret: string, day: string) {
  return sha256Hex(secret + ':' + day);
}

/**
 * The only per-person value the portal keeps. The salt rotates every UTC day and
 * old salts are deleted, so a stored token cannot be linked back to an address
 * or followed across days.
 */
export async function deriveVisitorHash(salt: string, address: string | null, userAgent: string | null, countryCode: string) {
  const digest = await sha256Hex([salt, address || 'no-address', userAgent || 'no-agent', countryCode].join('|'));
  return digest.slice(0, 32);
}

export function countryName(code: string, locale = 'en') {
  if (!COUNTRY_PATTERN.test(code) || code === UNKNOWN_COUNTRY) return 'Unknown';
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

export function countryFlag(code: string) {
  if (!COUNTRY_PATTERN.test(code) || code === UNKNOWN_COUNTRY) return '🏳️';
  return String.fromCodePoint(...[...code.toUpperCase()].map((letter) => 0x1f1a5 + letter.charCodeAt(0)));
}
