-- REV online charging-station cache
-- Run this once in Cloudflare D1 database rev-db (binding name DB).
CREATE TABLE IF NOT EXISTS online_station_cache (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  name TEXT NOT NULL,
  address TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  operator TEXT,
  status TEXT,
  power_kw REAL,
  connectors_json TEXT NOT NULL DEFAULT '[]',
  source_url TEXT,
  source TEXT NOT NULL DEFAULT 'OpenStreetMap',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  raw_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_online_station_cache_source
  ON online_station_cache(source, source_id)
  WHERE source_id IS NOT NULL AND source_id <> '';
CREATE INDEX IF NOT EXISTS idx_online_station_cache_coords
  ON online_station_cache(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_online_station_cache_last_seen
  ON online_station_cache(last_seen_at);
