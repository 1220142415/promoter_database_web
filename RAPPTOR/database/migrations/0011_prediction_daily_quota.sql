-- Daily admission quota for authenticated whole-genome scans.
-- Supabase user IDs are stored; email addresses and sequence data are not.

ALTER TABLE prediction_tickets
  ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'predict'
  CHECK (task_kind IN ('predict', 'genome_scan'));

CREATE TABLE IF NOT EXISTS prediction_daily_quota (
  user_id TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  task_kind TEXT NOT NULL CHECK (task_kind = 'genome_scan'),
  used INTEGER NOT NULL DEFAULT 1 CHECK (used BETWEEN 0 AND 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, quota_day, task_kind)
);
