-- A ticket may authorize one Worker-side external reference download.
-- Docker still owns final ticket consumption (used_at).
ALTER TABLE prediction_tickets ADD COLUMN reference_download_started_at TEXT;
