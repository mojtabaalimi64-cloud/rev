-- REV D1 migration: allow zero-distance trips (e.g. stationary tests)
-- Run ONCE against the existing rev-db database before deploying the updated Worker.
-- This rebuild preserves existing trip records and the driving_stats_json column.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE rev_driver_trips_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  vehicle_name TEXT NOT NULL DEFAULT 'خودروی ثبت‌نشده',
  vehicle_type TEXT NOT NULL DEFAULT 'bev' CHECK (vehicle_type IN ('bev','phev','hev','mhev')),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  distance_km REAL NOT NULL CHECK (distance_km >= 0 AND distance_km <= 5000),
  energy_kwh REAL NOT NULL CHECK (energy_kwh >= 0 AND energy_kwh <= 2000),
  start_soc REAL CHECK (start_soc IS NULL OR (start_soc >= 0 AND start_soc <= 100)),
  end_soc REAL CHECK (end_soc IS NULL OR (end_soc >= 0 AND end_soc <= 100)),
  energy_source TEXT NOT NULL DEFAULT 'manual' CHECK (energy_source IN ('obd','vehicle_api','gps_estimate','manual')),
  route_json TEXT,
  route_saved INTEGER NOT NULL DEFAULT 0 CHECK (route_saved IN (0,1)),
  created_at TEXT NOT NULL,
  driving_stats_json TEXT,
  FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE
);

INSERT INTO rev_driver_trips_new
  (id,user_id,vehicle_name,vehicle_type,started_at,ended_at,distance_km,energy_kwh,start_soc,end_soc,energy_source,route_json,route_saved,created_at,driving_stats_json)
SELECT
  id,user_id,vehicle_name,vehicle_type,started_at,ended_at,distance_km,energy_kwh,start_soc,end_soc,energy_source,route_json,route_saved,created_at,driving_stats_json
FROM rev_driver_trips;

DROP TABLE rev_driver_trips;
ALTER TABLE rev_driver_trips_new RENAME TO rev_driver_trips;
CREATE INDEX IF NOT EXISTS idx_rev_driver_trips_user_date ON rev_driver_trips(user_id, ended_at DESC);

COMMIT;
PRAGMA foreign_keys=ON;
