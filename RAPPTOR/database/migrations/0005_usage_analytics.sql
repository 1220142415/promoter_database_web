-- Privacy-preserving usage analytics.
--
-- No IP address is ever stored. Each request is reduced to a coarse location
-- (supplied by the Cloudflare edge) plus a visitor token that is the SHA-256 of
-- a salt, the address and the user agent. The salt rotates every UTC day, so
-- tokens cannot be linked across days and cannot be reversed into an address.

CREATE TABLE IF NOT EXISTS analytics_daily_geo (
  day TEXT NOT NULL,
  country_code TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, country_code, region, city)
);

CREATE INDEX IF NOT EXISTS analytics_daily_geo_day ON analytics_daily_geo(day);

CREATE TABLE IF NOT EXISTS analytics_daily_path (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);

CREATE INDEX IF NOT EXISTS analytics_daily_path_day ON analytics_daily_path(day);

-- One row per visitor per UTC day. `visitor_hash` is unlinkable across days and
-- is the only per-person value the portal keeps.
CREATE TABLE IF NOT EXISTS analytics_visitor_day (
  day TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  country_code TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (day, visitor_hash)
);

CREATE INDEX IF NOT EXISTS analytics_visitor_day_day_country ON analytics_visitor_day(day, country_code);

-- Daily rotating salt. Rows older than two days are deleted by the collector,
-- which permanently breaks any link between a stored token and an address.
CREATE TABLE IF NOT EXISTS analytics_salt (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);
