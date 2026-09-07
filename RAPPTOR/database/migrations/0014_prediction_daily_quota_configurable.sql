-- Allow the configured per-user scan quota to exceed the original one-per-day limit.
CREATE TABLE prediction_daily_quota_configurable (
  user_id TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  task_kind TEXT NOT NULL CHECK (task_kind = 'genome_scan'),
  used INTEGER NOT NULL DEFAULT 1 CHECK (used >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, quota_day, task_kind)
);

INSERT INTO prediction_daily_quota_configurable
  (user_id, quota_day, task_kind, used, updated_at)
SELECT user_id, quota_day, task_kind, used, updated_at
FROM prediction_daily_quota;

DROP TABLE prediction_daily_quota;
ALTER TABLE prediction_daily_quota_configurable RENAME TO prediction_daily_quota;
