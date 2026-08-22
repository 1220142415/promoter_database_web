import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import UsageTrend from '@/components/usage-trend';
import UsageWorldMap from '@/components/usage-world-map';
import { readUsageSettings } from '@/lib/usage-analytics';
import { readUsageReport, usageDatabase } from '@/lib/usage-analytics-store';
import type { UsageReport } from '@/types/usage-analytics';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Usage | SeqEdge',
  robots: { index: false, follow: false },
};

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '12 months' },
  { days: 0, label: 'All time' },
];

const DEFAULT_RANGE = 30;

function parseRange(value: string | string[] | undefined) {
  const requested = Number(Array.isArray(value) ? value[0] : value);
  return RANGES.some((range) => range.days === requested) ? requested : DEFAULT_RANGE;
}

function percent(value: number) {
  if (value <= 0) return '0%';
  return value < 0.001 ? '<0.1%' : `${(value * 100).toFixed(1)}%`;
}

function UsageNotice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="usage-notice">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function UsageBody({ report, rangeDays }: { report: UsageReport; rangeDays: number }) {
  if (report.totals.views === 0) {
    return (
      <UsageNotice title="No page views recorded yet">
        <p>
          Counting starts once the portal is deployed behind Cloudflare and someone opens a page. Requests from the
          admin section, APIs, genome data ranges and known crawlers are never counted.
        </p>
      </UsageNotice>
    );
  }

  return (
    <>
      <section className="usage-metrics" aria-label="Summary">
        <div><span>Visitors</span><strong>{report.totals.visitors.toLocaleString()}</strong><small>Unique per day, summed over the range</small></div>
        <div><span>Page views</span><strong>{report.totals.views.toLocaleString()}</strong><small>Full page loads; in-app navigation is not counted</small></div>
        <div><span>Countries</span><strong>{report.totals.countries.toLocaleString()}</strong><small>With at least one visitor</small></div>
        <div><span>Cities</span><strong>{report.totals.cities.toLocaleString()}</strong><small>Top locations recorded</small></div>
      </section>

      <section className="usage-panel">
        <h2>Where SeqEdge is used</h2>
        <UsageWorldMap countries={report.countries} />
      </section>

      <section className="usage-panel">
        <h2>Daily activity</h2>
        <UsageTrend daily={report.daily} />
      </section>

      <div className="usage-columns">
        <section className="usage-panel">
          <h2>Countries</h2>
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr><th scope="col">Country</th><th scope="col">Visitors</th><th scope="col">Views</th><th scope="col">Share</th></tr>
              </thead>
              <tbody>
                {report.countries.map((country) => (
                  <tr key={country.code}>
                    <th scope="row"><span aria-hidden="true">{country.flag}</span> {country.name}</th>
                    <td>{country.visitors.toLocaleString()}</td>
                    <td>{country.views.toLocaleString()}</td>
                    <td>
                      <span className="usage-share"><i style={{ width: `${Math.max(2, country.share * 100)}%` }} /></span>
                      {percent(country.share)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="usage-stack">
          <section className="usage-panel">
            <h2>Cities</h2>
            {report.cities.length === 0 ? (
              <p className="usage-empty">No city-level data. Set <code>SEQEDGE_ANALYTICS_PRECISION=city</code> and serve the portal through Cloudflare to record cities.</p>
            ) : (
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <thead>
                    <tr><th scope="col">City</th><th scope="col">Visitors</th><th scope="col">Views</th></tr>
                  </thead>
                  <tbody>
                    {report.cities.map((city) => (
                      <tr key={`${city.countryCode}-${city.region}-${city.city}`}>
                        <th scope="row">{city.city}<small>{[city.region, city.countryName].filter(Boolean).join(', ')}</small></th>
                        <td>{city.visitors.toLocaleString()}</td>
                        <td>{city.views.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="usage-panel">
            <h2>Pages</h2>
            <div className="usage-table-wrap">
              <table className="usage-table">
                <thead>
                  <tr><th scope="col">Path</th><th scope="col">Views</th></tr>
                </thead>
                <tbody>
                  {report.paths.map((entry) => (
                    <tr key={entry.path}>
                      <th scope="row"><code>{entry.path}</code></th>
                      <td>{entry.views.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      <p className="usage-export">
        <a href={`/api/admin/usage?days=${rangeDays}&format=csv`}>Download CSV</a>
        <a href={`/api/admin/usage?days=${rangeDays}`}>View JSON</a>
      </p>
    </>
  );
}

export default async function UsageDashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!process.env.SEQEDGE_ANALYTICS_USERNAME || !process.env.SEQEDGE_ANALYTICS_PASSWORD) notFound();

  const rangeDays = parseRange((await searchParams).days);
  const settings = readUsageSettings();
  const database = usageDatabase();

  let report: UsageReport | null = null;
  let failure: string | null = null;
  if (database) {
    try {
      report = await readUsageReport(database, rangeDays);
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : 'The usage tables could not be read.';
    }
  }

  return (
    <main className="portal-page usage-page">
      <section className="portal-shell page-intro">
        <p className="portal-kicker">Usage analytics</p>
        <h1>Who is using SeqEdge</h1>
        <p>
          Coarse location counts derived at the edge from the visitor address. No address is ever stored: each request is
          reduced to a country, an optional city and a token that is salted with a key rotated every day and deleted
          afterwards.
        </p>
        <nav className="usage-ranges" aria-label="Reporting range">
          {RANGES.map((range) => (
            <Link
              key={range.days}
              href={`/admin/usage?days=${range.days}`}
              className={range.days === rangeDays ? 'is-active' : undefined}
            >
              {range.label}
            </Link>
          ))}
        </nav>
      </section>

      <section className="portal-shell usage-content">
        {!settings.enabled && (
          <UsageNotice title="Collection is switched off">
            <p>
              <code>SEQEDGE_ANALYTICS</code> is set to <code>{process.env.SEQEDGE_ANALYTICS}</code>. Previously recorded
              days are still shown below; remove the variable to resume counting.
            </p>
          </UsageNotice>
        )}
        {!database && (
          <UsageNotice title="No D1 binding">
            <p>
              Usage counting needs the <code>SEQEDGE_DB</code> D1 binding. Bind it in <code>wrangler.toml</code>, then
              apply the migrations with <code>npx wrangler d1 migrations apply SEQEDGE_DB --remote</code>.
            </p>
          </UsageNotice>
        )}
        {failure && (
          <UsageNotice title="Usage tables unavailable">
            <p>{failure}</p>
            <p>Apply <code>migrations/0005_usage_analytics.sql</code> with <code>npx wrangler d1 migrations apply SEQEDGE_DB --remote</code>.</p>
          </UsageNotice>
        )}
        {report && <UsageBody report={report} rangeDays={rangeDays} />}
        {report && (
          <p className="usage-footnote">
            Range {report.startDay} to {report.endDay} (UTC){report.firstRecordedDay ? `, first recorded day ${report.firstRecordedDay}` : ''}.
            Retention {settings.retentionDays} days. Location precision: {settings.precision}.
          </p>
        )}
      </section>
    </main>
  );
}
