-- REV public ratings and administrator-managed display overrides.
-- Run in Cloudflare D1 database rev-db. Existing tables are retained.
CREATE TABLE IF NOT EXISTS rev_ratings (
  target_type TEXT NOT NULL CHECK (target_type IN ('station','store')),
  target_id TEXT NOT NULL,
  voter_hash TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id, voter_hash)
);
CREATE INDEX IF NOT EXISTS idx_rev_ratings_target ON rev_ratings(target_type, target_id);
CREATE TABLE IF NOT EXISTS rev_rating_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_rating_rate_limits_expiry ON rev_rating_rate_limits(expires_at);
CREATE TABLE IF NOT EXISTS rev_rating_overrides (
  target_type TEXT NOT NULL CHECK (target_type IN ('station','store')),
  target_id TEXT NOT NULL,
  public_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  owner_phone TEXT NOT NULL DEFAULT '',
  manual_average REAL NOT NULL CHECK (manual_average BETWEEN 0 AND 5),
  manual_count INTEGER NOT NULL CHECK (manual_count >= 0),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'admin',
  PRIMARY KEY (target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_rev_rating_overrides_code ON rev_rating_overrides(public_code);
CREATE INDEX IF NOT EXISTS idx_rev_rating_overrides_name ON rev_rating_overrides(display_name);
