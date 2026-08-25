-- Keep experimental TSS releases independent from the prediction portal.
ALTER TABLE releases ADD COLUMN release_kind TEXT NOT NULL DEFAULT 'prediction'
  CHECK (release_kind IN ('prediction', 'experimental_tss'));

CREATE TABLE experimental_portal_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_release_id TEXT NOT NULL UNIQUE REFERENCES releases(release_id)
);

CREATE TRIGGER portal_state_prediction_release_kind_insert
BEFORE INSERT ON portal_state
FOR EACH ROW
WHEN COALESCE((SELECT release_kind FROM releases WHERE release_id = NEW.active_release_id), 'prediction') <> 'prediction'
BEGIN
  SELECT RAISE(ABORT, 'prediction portal requires a prediction release');
END;

CREATE TRIGGER portal_state_prediction_release_kind_update
BEFORE UPDATE OF active_release_id ON portal_state
FOR EACH ROW
WHEN COALESCE((SELECT release_kind FROM releases WHERE release_id = NEW.active_release_id), 'prediction') <> 'prediction'
BEGIN
  SELECT RAISE(ABORT, 'prediction portal requires a prediction release');
END;

CREATE TRIGGER experimental_portal_state_release_kind_insert
BEFORE INSERT ON experimental_portal_state
FOR EACH ROW
WHEN (SELECT release_kind FROM releases WHERE release_id = NEW.active_release_id) <> 'experimental_tss'
BEGIN
  SELECT RAISE(ABORT, 'experimental portal requires an experimental_tss release');
END;

CREATE TRIGGER experimental_portal_state_release_kind_update
BEFORE UPDATE OF active_release_id ON experimental_portal_state
FOR EACH ROW
WHEN (SELECT release_kind FROM releases WHERE release_id = NEW.active_release_id) <> 'experimental_tss'
BEGIN
  SELECT RAISE(ABORT, 'experimental portal requires an experimental_tss release');
END;

CREATE INDEX releases_kind_publication
  ON releases(release_kind, publication_status, release_id);
