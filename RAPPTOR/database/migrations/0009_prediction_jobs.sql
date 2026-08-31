-- Permanent, sequence-free audit records for queued prediction jobs.
-- Large inputs and result artifacts remain outside D1.

CREATE TABLE IF NOT EXISTS prediction_jobs (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) = 32),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  mode TEXT NOT NULL CHECK (mode IN ('predict', 'genome_scan')),
  model_version TEXT NOT NULL,
  input_bases INTEGER NOT NULL CHECK (input_bases > 0),
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  checkpoint_sha256 TEXT,
  model_config_sha256 TEXT,
  artifacts_json TEXT,
  error_type TEXT,
  error_message TEXT,
  submitted_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  artifacts_expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS prediction_jobs_status_updated
  ON prediction_jobs(status, updated_at);

CREATE INDEX IF NOT EXISTS prediction_jobs_submitted
  ON prediction_jobs(submitted_at);
