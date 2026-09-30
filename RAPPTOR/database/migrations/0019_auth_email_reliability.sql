-- Shared, atomic OTP send reservations. Email scopes use a keyed HMAC, not raw addresses.
CREATE TABLE IF NOT EXISTS auth_email_limits (
  scope TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  next_send_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Freeze the complete provider payload before the first send. Capability links remain encrypted.
ALTER TABLE prediction_job_notifications ADD COLUMN email_payload_ciphertext TEXT;
