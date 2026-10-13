-- REV authentication settings. Additive migration; does not alter existing site tables.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rev_auth_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
INSERT OR IGNORE INTO rev_auth_settings (id, enabled, updated_at, updated_by)
VALUES (1, 0, datetime('now'), 'migration');

CREATE INDEX IF NOT EXISTS idx_rev_users_email ON rev_users(email_normalized);

CREATE TABLE IF NOT EXISTS rev_auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_auth_rate_limits_expiry
  ON rev_auth_rate_limits(expires_at);
