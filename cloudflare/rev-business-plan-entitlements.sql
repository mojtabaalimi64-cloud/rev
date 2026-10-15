-- REV business plan assignments and server-side entitlements.
-- Apply once to D1 database rev-db before deploying the updated Worker.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS rev_business_plan_assignments (
  business_id TEXT PRIMARY KEY,
  plan_code TEXT NOT NULL CHECK (plan_code IN ('free','professional','featured','sponsor')),
  plan_name TEXT NOT NULL,
  plan_status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (plan_status IN ('active','pending_payment','expired','suspended','cancelled')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('paid','pending','waived','failed','refunded')),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  features_json TEXT NOT NULL DEFAULT '{}',
  admin_note TEXT,
  assigned_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (business_id) REFERENCES rev_business_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rev_business_plan_status ON rev_business_plan_assignments(plan_status, expires_at);
