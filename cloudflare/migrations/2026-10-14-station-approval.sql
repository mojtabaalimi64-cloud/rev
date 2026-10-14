-- REV charging-station approval workflow
-- Run this ONCE in Cloudflare D1 > rev-db > Console.
-- Existing stations become pending review by default, so none are public until approved.
ALTER TABLE stations ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE stations ADD COLUMN reviewed_at TEXT;
ALTER TABLE stations ADD COLUMN reviewed_by TEXT;
ALTER TABLE stations ADD COLUMN review_note TEXT;

CREATE INDEX IF NOT EXISTS idx_stations_approval_name
ON stations (approval_status, name COLLATE NOCASE);
