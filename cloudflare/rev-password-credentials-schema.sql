-- REV password credential table (additive and safe to re-run).
-- Apply only after rev-community-schema.sql has created rev_users.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS rev_password_credentials (
  user_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL DEFAULT 'PBKDF2-SHA256',
  iterations INTEGER NOT NULL DEFAULT 310000 CHECK (iterations BETWEEN 100000 AND 1000000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE
);
