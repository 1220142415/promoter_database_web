-- Metadata-only persistence for the public prediction interface demo.
-- Raw candidate and genome sequences are never stored in these tables.

CREATE TABLE IF NOT EXISTS prediction_demo_tickets (
  ticket_hash TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_marker TEXT
);

CREATE INDEX IF NOT EXISTS prediction_demo_tickets_expiry
  ON prediction_demo_tickets(expires_at_ms);

CREATE TABLE IF NOT EXISTS prediction_demo_uploads (
  upload_token_hash TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS prediction_demo_uploads_expiry
  ON prediction_demo_uploads(expires_at_ms);

CREATE TABLE IF NOT EXISTS prediction_demo_jobs (
  job_id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL,
  submission_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  submitted_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS prediction_demo_jobs_created
  ON prediction_demo_jobs(created_at_ms);
