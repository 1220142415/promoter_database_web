import { shiftDay } from './analytics';

export async function purgeExpiredUsage(database: D1Database, day: string, retentionDays: number) {
  const cutoff = shiftDay(day, -(retentionDays - 1));
  await database.batch([
    database.prepare('DELETE FROM analytics_visitor_day WHERE day < ?').bind(cutoff),
    database.prepare('DELETE FROM analytics_daily_geo WHERE day < ?').bind(cutoff),
    database.prepare('DELETE FROM analytics_daily_path WHERE day < ?').bind(cutoff),
    database.prepare('DELETE FROM analytics_salt WHERE day < ?').bind(shiftDay(day, -1)),
  ]);
}
