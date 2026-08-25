import { afterEach, describe, expect, it } from 'vitest';

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
} from '@/features/usage/analytics';

const BROWSER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function request(pathname: string, headers: Record<string, string> = {}, method = 'GET') {
  return {
    method,
    nextUrl: { pathname },
    headers: new Headers({ 'sec-fetch-dest': 'document', ...headers }),
  };
}

const analyticsEnvKeys = ['RAPPTOR_ANALYTICS', 'RAPPTOR_ANALYTICS_PRECISION', 'RAPPTOR_ANALYTICS_RETENTION_DAYS', 'RAPPTOR_ANALYTICS_SALT', 'RAPPTOR_ANALYTICS_TRUST_PROXY_HEADERS'];
const originalEnv = Object.fromEntries(analyticsEnvKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of analyticsEnvKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('countable page requests', () => {
  it('counts a document navigation', () => {
    expect(isCountablePageRequest(request('/genomes'))).toBe(true);
  });

  it('ignores API, data and asset traffic', () => {
    expect(isCountablePageRequest(request('/api/genomes'))).toBe(false);
    expect(isCountablePageRequest(request('/api/remote-data/GCA_000411415.1/reference.fa.gz'))).toBe(false);
    expect(isCountablePageRequest(request('/_next/static/chunk.js'))).toBe(false);
    expect(isCountablePageRequest(request('/robots.txt'))).toBe(false);
  });

  it('ignores usage dashboards so reading the report does not inflate it', () => {
    expect(isCountablePageRequest(request('/admin/usage'))).toBe(false);
    expect(isCountablePageRequest(request('/usage'))).toBe(false);
  });

  it('ignores router prefetches, sub-resource fetches and non-GET methods', () => {
    expect(isCountablePageRequest(request('/genomes', { 'next-router-prefetch': '1' }))).toBe(false);
    expect(isCountablePageRequest(request('/genomes', { 'sec-purpose': 'prefetch;prerender' }))).toBe(false);
    expect(isCountablePageRequest(request('/genomes', { 'sec-fetch-dest': 'empty' }))).toBe(false);
    expect(isCountablePageRequest(request('/genomes', {}, 'POST'))).toBe(false);
  });

  it('falls back to the accept header when sec-fetch-dest is missing', () => {
    const withoutDestination = { method: 'GET', nextUrl: { pathname: '/' }, headers: new Headers({ accept: 'text/html,*/*' }) };
    const jsonClient = { method: 'GET', nextUrl: { pathname: '/' }, headers: new Headers({ accept: 'application/json' }) };
    expect(isCountablePageRequest(withoutDestination)).toBe(true);
    expect(isCountablePageRequest(jsonClient)).toBe(false);
  });
});

describe('path normalisation', () => {
  it('collapses genome accessions into a single bucket', () => {
    expect(normalizePath('/genomes/GCA_000411415.1')).toBe('/genomes/[accession]');
    expect(normalizePath('/genomes/GCF_000005845.2')).toBe('/genomes/[accession]');
  });

  it('keeps static routes and bounds unexpected depth', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/data')).toBe('/data');
    expect(normalizePath('/a/b/c/d/e/f')).toBe('/a/b/c/d');
  });
});

describe('bot filtering', () => {
  it('keeps browsers and drops crawlers and tooling', () => {
    expect(isLikelyBot(BROWSER_AGENT)).toBe(false);
    expect(isLikelyBot('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true);
    expect(isLikelyBot('curl/8.4.0')).toBe(true);
    expect(isLikelyBot('python-requests/2.32')).toBe(true);
    expect(isLikelyBot(null)).toBe(true);
  });
});

describe('geolocation', () => {
  it('reads the Cloudflare request properties', () => {
    const geo = resolveGeo({ country: 'de', city: 'Heidelberg', region: 'Baden-Wurttemberg', latitude: '49.41', longitude: '8.69' }, new Headers(), 'city');
    expect(geo).toEqual({ countryCode: 'DE', city: 'Heidelberg', region: 'Baden-Wurttemberg', latitude: 49.41, longitude: 8.69 });
  });

  it('only trusts edge and proxy geography from the matching runtime source', () => {
    const headers = new Headers({ 'cf-ipcountry': 'JP', 'x-vercel-ip-country': 'CN', 'x-vercel-ip-city': 'Shanghai' });
    expect(resolveGeo(null, headers).countryCode).toBe(UNKNOWN_COUNTRY);
    expect(resolveGeo(null, headers, 'country', { cloudflare: true, proxyHeaders: false }).countryCode).toBe('JP');
    expect(resolveGeo(null, headers, 'city', { cloudflare: false, proxyHeaders: true })).toMatchObject({ countryCode: 'CN', city: 'Shanghai' });
  });

  it('reports an unknown country without inventing a location', () => {
    expect(resolveGeo(null, new Headers())).toEqual({ countryCode: UNKNOWN_COUNTRY, region: '', city: '', latitude: null, longitude: null });
  });

  it('drops city detail at country precision', () => {
    const geo = resolveGeo({ country: 'DE', city: 'Heidelberg', latitude: '49.41' }, new Headers(), 'country');
    expect(geo).toEqual({ countryCode: 'DE', region: '', city: '', latitude: null, longitude: null });
  });
});

describe('client address resolution', () => {
  it('prefers the edge address over forwarded headers', () => {
    const headers = new Headers({ 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.9, 10.0.0.1' });
    expect(resolveClientAddress(headers, { cloudflare: true, proxyHeaders: true })).toBe('203.0.113.5');
  });

  it('rejects spoofed forwarding headers unless proxy trust is explicit', () => {
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.5',
      'x-real-ip': '198.51.100.8',
      'x-forwarded-for': '198.51.100.9, 10.0.0.1',
    });
    expect(resolveClientAddress(headers)).toBeNull();
    expect(resolveClientAddress(headers, { cloudflare: false, proxyHeaders: true })).toBe('198.51.100.8');
    expect(resolveClientAddress(new Headers({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }), { cloudflare: false, proxyHeaders: true })).toBe('198.51.100.9');
    expect(resolveClientAddress(new Headers())).toBeNull();
  });
});

describe('visitor tokens', () => {
  it('is stable for one visitor within a day', async () => {
    const first = await deriveVisitorHash('salt-a', '203.0.113.5', BROWSER_AGENT, 'DE');
    const second = await deriveVisitorHash('salt-a', '203.0.113.5', BROWSER_AGENT, 'DE');
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it('cannot be linked across days because the salt rotates', async () => {
    const today = await deriveVisitorHash('salt-a', '203.0.113.5', BROWSER_AGENT, 'DE');
    const tomorrow = await deriveVisitorHash('salt-b', '203.0.113.5', BROWSER_AGENT, 'DE');
    expect(today).not.toBe(tomorrow);
  });

  it('separates different visitors', async () => {
    const first = await deriveVisitorHash('salt-a', '203.0.113.5', BROWSER_AGENT, 'DE');
    const second = await deriveVisitorHash('salt-a', '203.0.113.6', BROWSER_AGENT, 'DE');
    expect(first).not.toBe(second);
  });
});

describe('presentation helpers', () => {
  it('names and flags countries', () => {
    expect(countryName('DE')).toBe('Germany');
    expect(countryName(UNKNOWN_COUNTRY)).toBe('Unknown');
    expect(countryFlag('DE')).toBe('🇩🇪');
    expect(countryFlag(UNKNOWN_COUNTRY)).toBe('🏳️');
  });

  it('shifts UTC days across month boundaries', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-01-01', -30)).toBe('2025-12-02');
  });
});

describe('settings', () => {
  it('only counts after an explicit on value', () => {
    delete process.env.RAPPTOR_ANALYTICS;
    expect(readUsageSettings().enabled).toBe(false);
    process.env.RAPPTOR_ANALYTICS = 'on';
    expect(readUsageSettings().enabled).toBe(true);
    process.env.RAPPTOR_ANALYTICS = 'ON';
    expect(readUsageSettings().enabled).toBe(true);
    process.env.RAPPTOR_ANALYTICS = 'false';
    expect(readUsageSettings().enabled).toBe(false);
  });

  it('reads precision and retention overrides', () => {
    process.env.RAPPTOR_ANALYTICS_PRECISION = 'city';
    process.env.RAPPTOR_ANALYTICS_RETENTION_DAYS = '90';
    process.env.RAPPTOR_ANALYTICS_TRUST_PROXY_HEADERS = 'on';
    process.env.RAPPTOR_ANALYTICS_SALT = 'obsolete-fixed-salt';
    expect(readUsageSettings()).toMatchObject({ precision: 'city', retentionDays: 90, trustProxyHeaders: true });
    expect(readUsageSettings()).not.toHaveProperty('salt');
    delete process.env.RAPPTOR_ANALYTICS_PRECISION;
    delete process.env.RAPPTOR_ANALYTICS_RETENTION_DAYS;
    delete process.env.RAPPTOR_ANALYTICS_TRUST_PROXY_HEADERS;
    expect(readUsageSettings()).toMatchObject({ precision: 'country', retentionDays: 400, trustProxyHeaders: false });
  });
});
