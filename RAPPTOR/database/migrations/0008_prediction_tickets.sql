-- One-time admission tickets for the external RAPPtor prediction service.
-- Raw addresses and plaintext tickets are never stored.

CREATE TABLE IF NOT EXISTS prediction_tickets (
  ticket_hash TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'prediction'),
  model_version TEXT NOT NULL,
  requested_bases INTEGER NOT NULL CHECK (requested_bases > 0),
  max_bases INTEGER NOT NULL CHECK (max_bases > 0),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS prediction_tickets_ip_issued
  ON prediction_tickets(ip_hash, issued_at);

CREATE INDEX IF NOT EXISTS prediction_tickets_expires
  ON prediction_tickets(expires_at);
