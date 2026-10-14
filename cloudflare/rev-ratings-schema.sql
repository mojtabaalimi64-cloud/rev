-- REV public ratings: additive migration for D1 database rev-db
CREATE TABLE IF NOT EXISTS rev_ratings (
  target_type TEXT NOT NULL CHECK (target_type IN ('station','store')),
  target_id TEXT NOT NULL,
  voter_hash TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id, voter_hash)
);
CREATE INDEX IF NOT EXISTS idx_rev_ratings_target
  ON rev_ratings(target_type, target_id);
CREATE TABLE IF NOT EXISTS rev_rating_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_rating_rate_limits_expiry
  ON rev_rating_rate_limits(expires_at);
