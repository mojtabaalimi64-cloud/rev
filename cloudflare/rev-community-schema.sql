-- REV staged registration and community foundation
-- Safe additive migration: creates new rev_* tables only.
-- Apply to Cloudflare D1 database rev-db after reviewing this file.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rev_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  email_normalized TEXT NOT NULL UNIQUE,
  email_verified_at TEXT,
  phone_e164 TEXT UNIQUE,
  phone_verified_at TEXT,
  account_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (account_status IN ('pending','active','suspended','deleted')),
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('member','moderator','admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS rev_verification_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
  destination_normalized TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','verify_phone','login','recover')),
  token_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  request_window_key TEXT,
  FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rev_challenges_user
  ON rev_verification_challenges(user_id, purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_rev_challenges_expiry
  ON rev_verification_challenges(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS rev_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rev_sessions_user
  ON rev_sessions(user_id, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS rev_user_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  consent_type TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  withdrawn_at TEXT,
  FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rev_consents_user
  ON rev_user_consents(user_id, consent_type);

-- Community submissions are intentionally separate from existing OSM/cache rows.
CREATE TABLE IF NOT EXISTS rev_station_submissions (
  id TEXT PRIMARY KEY,
  submitted_by TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  operator TEXT,
  connector_types_json TEXT NOT NULL DEFAULT '[]',
  power_kw REAL,
  claimed_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (claimed_status IN ('active','inactive','unknown')),
  evidence_url TEXT,
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending','approved','rejected','needs_review')),
  moderated_by TEXT,
  moderated_at TEXT,
  moderation_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (submitted_by) REFERENCES rev_users(id),
  FOREIGN KEY (moderated_by) REFERENCES rev_users(id)
);
CREATE INDEX IF NOT EXISTS idx_rev_station_submissions_status
  ON rev_station_submissions(moderation_status, created_at);

CREATE TABLE IF NOT EXISTS rev_station_verifications (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('confirm','contradict','cannot_confirm')),
  note TEXT,
  evidence_url TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES rev_station_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (verified_by) REFERENCES rev_users(id),
  UNIQUE (submission_id, verified_by)
);

CREATE TABLE IF NOT EXISTS rev_trip_checklists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  origin_label TEXT NOT NULL,
  destination_label TEXT NOT NULL,
  vehicle_label TEXT,
  battery_percent INTEGER CHECK (battery_percent BETWEEN 0 AND 100),
  reserve_percent INTEGER CHECK (reserve_percent BETWEEN 0 AND 100),
  items_json TEXT NOT NULL DEFAULT '[]',
  readiness_score INTEGER CHECK (readiness_score BETWEEN 0 AND 100),
  score_version TEXT NOT NULL DEFAULT 'v1',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rev_trip_checklists_user
  ON rev_trip_checklists(user_id, created_at);

CREATE TABLE IF NOT EXISTS rev_repair_shops (
  id TEXT PRIMARY KEY,
  submitted_by TEXT NOT NULL,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude REAL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL CHECK (longitude BETWEEN -180 AND 180),
  phone TEXT,
  website TEXT,
  brands_json TEXT NOT NULL DEFAULT '[]',
  services_json TEXT NOT NULL DEFAULT '[]',
  license_details TEXT,
  license_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (license_status IN ('unverified','pending','verified','rejected','expired')),
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending','approved','rejected','needs_review')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (submitted_by) REFERENCES rev_users(id),
  UNIQUE (name, city, address)
);
CREATE INDEX IF NOT EXISTS idx_rev_repair_shops_city
  ON rev_repair_shops(city, moderation_status, license_status);

CREATE TABLE IF NOT EXISTS rev_repair_shop_reviews (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  positive_vote INTEGER NOT NULL DEFAULT 1 CHECK (positive_vote IN (0,1)),
  review_text TEXT,
  visit_date TEXT,
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending','published','hidden')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES rev_repair_shops(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE,
  UNIQUE (shop_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_rev_shop_reviews_shop
  ON rev_repair_shop_reviews(shop_id, moderation_status, created_at);
