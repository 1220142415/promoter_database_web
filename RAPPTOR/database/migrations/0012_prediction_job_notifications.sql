-- Temporary notification outbox, separate from permanent, sequence-free job metadata.
CREATE TABLE IF NOT EXISTS prediction_job_notifications (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) = 32),
  user_id TEXT NOT NULL,
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  task_kind TEXT NOT NULL CHECK (task_kind IN ('predict', 'genome_scan')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed')),
  artifacts_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  first_attempt_at TEXT,
  sent_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS prediction_notifications_retry
  ON prediction_job_notifications(status, attempts, updated_at);
CREATE INDEX IF NOT EXISTS prediction_notifications_retention
  ON prediction_job_notifications(created_at);
