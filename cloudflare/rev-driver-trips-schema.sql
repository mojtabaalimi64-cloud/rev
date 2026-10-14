-- REV private driver trip history and optional GPS route storage.
-- Apply once to Cloudflare D1 database rev-db.
-- GPS coordinates are stored only when the user explicitly opts in.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rev_driver_trips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  vehicle_name TEXT NOT NULL DEFAULT 'خودروی ثبت‌نشده',
  vehicle_type TEXT NOT NULL DEFAULT 'bev'
    CHECK (vehicle_type IN ('bev','phev','hev','mhev')),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  distance_km REAL NOT NULL CHECK (distance_km > 0 AND distance_km <= 5000),
  energy_kwh REAL NOT NULL CHECK (energy_kwh >= 0 AND energy_kwh <= 2000),
  start_soc REAL CHECK (start_soc IS NULL OR (start_soc >= 0 AND start_soc <= 100)),
  end_soc REAL CHECK (end_soc IS NULL OR (end_soc >= 0 AND end_soc <= 100)),
  energy_source TEXT NOT NULL DEFAULT 'gps_estimate'
    CHECK (energy_source IN ('obd','vehicle_api','gps_estimate','manual')),
  route_json TEXT,
  route_saved INTEGER NOT NULL DEFAULT 0 CHECK (route_saved IN (0,1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rev_driver_trips_user_date
  ON rev_driver_trips(user_id, ended_at DESC);
