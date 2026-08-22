import { readUsageReport, usageDatabase } from '@/lib/usage-analytics-store';
import type { UsageReport } from '@/types/usage-analytics';

export const dynamic = 'force-dynamic';

const ALLOWED_RANGES = [7, 30, 90, 365, 0];
const DEFAULT_RANGE = 30;
const DATASETS = ['countries', 'cities', 'paths', 'daily'] as const;

type Dataset = (typeof DATASETS)[number];

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvFor(report: UsageReport, dataset: Dataset) {
  if (dataset === 'cities') {
    return [
      ['country_code', 'country_name', 'region', 'city', 'visitors', 'views'],
      ...report.cities.map((row) => [row.countryCode, row.countryName, row.region, row.city, row.visitors, row.views]),
    ];
  }
  if (dataset === 'paths') {
    return [['path', 'views'], ...report.paths.map((row) => [row.path, row.views])];
  }
  if (dataset === 'daily') {
    return [['day', 'visitors', 'views'], ...report.daily.map((row) => [row.day, row.visitors, row.views])];
  }
  return [
    ['country_code', 'country_name', 'visitors', 'views', 'share'],
    ...report.countries.map((row) => [row.code, row.name, row.visitors, row.views, row.share.toFixed(4)]),
  ];
}

export async function GET(request: Request) {
  if (!process.env.SEQEDGE_ANALYTICS_USERNAME || !process.env.SEQEDGE_ANALYTICS_PASSWORD) {
    return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const database = usageDatabase();
  if (!database) {
    return Response.json({ error: 'SEQEDGE_DB is not bound to this deployment.' }, { status: 503 });
  }

  const params = new URL(request.url).searchParams;
  const requestedRange = Number(params.get('days'));
  const rangeDays = ALLOWED_RANGES.includes(requestedRange) ? requestedRange : DEFAULT_RANGE;
  const requestedDataset = params.get('dataset');
  const dataset: Dataset = DATASETS.includes(requestedDataset as Dataset) ? requestedDataset as Dataset : 'countries';

  let report: UsageReport;
  try {
    report = await readUsageReport(database, rangeDays);
  } catch {
    return Response.json({ error: 'The usage tables could not be read. Apply the analytics migration first.' }, { status: 503 });
  }

  if (params.get('format') !== 'csv') {
    return Response.json(report, { headers: { 'Cache-Control': 'no-store' } });
  }

  const body = csvFor(report, dataset).map((row) => row.map(csvCell).join(',')).join('\n');
  return new Response(`${body}\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="seqedge-usage-${dataset}-${report.startDay}-to-${report.endDay}.csv"`,
    },
  });
}
