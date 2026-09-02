import { shiftDay } from './analytics';

export async function purgeExpiredUsage(database: D1Database, day: string, retentionDays: number) {
  const cutoff = shiftDay(day, -(retentionDays - 1));
  const now = Date.parse(day + 'T00:00:00.000Z');
  await database.batch([
    database.prepare('DELETE FROM analytics_visitor_day WHERE day < ?').bind(cutoff),
    database.prepare('DELETE FROM analytics_daily_geo WHERE day < ?').bind(cutoff),
    database.prepare('DELETE FROM analytics_daily_path WHERE day < ?').bind(cutoff),
    database.prepare('DELETE FROM analytics_salt WHERE day < ?').bind(shiftDay(day, -1)),
    database.prepare('DELETE FROM prediction_tickets WHERE expires_at < ?').bind(day + 'T00:00:00.000Z'),
    database.prepare('DELETE FROM prediction_demo_tickets WHERE expires_at_ms < ?').bind(now),
    database.prepare('DELETE FROM prediction_demo_uploads WHERE expires_at_ms < ?').bind(now),
    database.prepare('DELETE FROM prediction_demo_jobs WHERE created_at_ms < ?').bind(now - 7 * 24 * 60 * 60 * 1_000),
  ]);
}
