-- Count every accepted prediction by input bases while retaining the legacy scan counter.
ALTER TABLE prediction_daily_quota
ADD COLUMN used_bases INTEGER NOT NULL DEFAULT 0 CHECK (used_bases >= 0);
