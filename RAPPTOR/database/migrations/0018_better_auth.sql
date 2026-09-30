-- Better Auth email OTP, user, session and durable rate-limit storage.
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
  email_verified INTEGER NOT NULL, image TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_user_email ON user(email);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token TEXT NOT NULL, expires_at INTEGER NOT NULL,
  ip_address TEXT, user_agent TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_session_token ON session(token);
CREATE INDEX IF NOT EXISTS auth_session_user ON session(user_id);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  access_token TEXT, refresh_token TEXT,
  access_token_expires_at INTEGER, refresh_token_expires_at INTEGER,
  scope TEXT, id_token TEXT, password TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_account_user ON account(user_id);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_verification_identifier ON verification(identifier);

CREATE TABLE IF NOT EXISTS rate_limit (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL, last_request INTEGER NOT NULL
);
