-- REV business portal migration (additive only)
-- Apply to D1 database rev-db after rev-community-schema.sql / rev-auth-schema.sql.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rev_business_profiles (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  business_type TEXT NOT NULL CHECK (business_type IN ('store','repair','charging')),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  phone TEXT,
  website TEXT,
  description TEXT,
  services_json TEXT NOT NULL DEFAULT '[]',
  brands_json TEXT NOT NULL DEFAULT '[]',
  opening_hours TEXT,
  license_details TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','needs_review','suspended')),
  moderation_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES rev_users(id) ON DELETE CASCADE,
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);
CREATE INDEX IF NOT EXISTS idx_rev_business_owner ON rev_business_profiles(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rev_business_public ON rev_business_profiles(status, business_type, city);

CREATE TABLE IF NOT EXISTS rev_business_products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  price_text TEXT,
  image_url TEXT,
  product_url TEXT,
  stock_status TEXT NOT NULL DEFAULT 'unknown' CHECK (stock_status IN ('in_stock','out_of_stock','preorder','unknown')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  moderation_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (business_id) REFERENCES rev_business_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rev_products_business ON rev_business_products(business_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rev_products_public ON rev_business_products(status, updated_at DESC);
