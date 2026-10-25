-- The service's tables as src/db/store.ts makes them; the tests build their databases with it.
CREATE TABLE IF NOT EXISTS checks (
  key         TEXT PRIMARY KEY,
  issue_id    TEXT,
  status      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  checked_at  TEXT NOT NULL,
  summary     TEXT,
  reporter    TEXT,
  base_checks TEXT,
  verdict     TEXT,
  comment     TEXT,
  comment_id  TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS checks_status ON checks (status);
CREATE UNIQUE INDEX IF NOT EXISTS checks_issue_id ON checks (issue_id);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
