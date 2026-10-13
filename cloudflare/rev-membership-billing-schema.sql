-- REV annual membership and billing foundation. Additive migration.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rev_membership_plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('individual','charging_station','repair_shop')),
  duration_days INTEGER NOT NULL DEFAULT 365 CHECK (duration_days BETWEEN 1 AND 366),
  amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'IRR',
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  features_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rev_memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('individual','charging_station','repair_shop')),
  subject_type TEXT CHECK (subject_type IN ('repair_shop','charging_station')),
  subject_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','active','expired','cancelled','suspended','refunded')),
  starts_at TEXT,
  expires_at TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES rev_membership_plans(id),
  CHECK ((audience = 'individual' AND subject_type IS NULL AND subject_id IS NULL)
      OR (audience <> 'individual' AND subject_type IS NOT NULL AND subject_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_rev_memberships_user_status ON rev_memberships(user_id,status,expires_at);
CREATE INDEX IF NOT EXISTS idx_rev_memberships_subject ON rev_memberships(subject_type,subject_id,status,expires_at);

CREATE TABLE IF NOT EXISTS rev_membership_payments (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual','local_gateway','stripe','other')),
  provider_payment_id TEXT,
  provider_event_id TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'IRR',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','succeeded','failed','cancelled','refunded')),
  idempotency_key TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  verified_by TEXT,
  verification_note TEXT,
  FOREIGN KEY (membership_id) REFERENCES rev_memberships(id),
  FOREIGN KEY (user_id) REFERENCES rev_users(id),
  FOREIGN KEY (verified_by) REFERENCES rev_users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rev_payment_provider_id ON rev_membership_payments(provider,provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rev_payment_provider_event ON rev_membership_payments(provider,provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rev_payments_user_status ON rev_membership_payments(user_id,status,created_at);

CREATE TABLE IF NOT EXISTS rev_payment_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processing_status TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received','processed','ignored','failed')),
  processing_note TEXT,
  UNIQUE(provider,provider_event_id)
);

INSERT OR IGNORE INTO rev_membership_plans
(id,code,display_name,audience,duration_days,amount_minor,currency,is_active,features_json,created_at,updated_at)
VALUES
('plan-individual-annual','individual_annual','عضویت سالانه اعضا','individual',365,0,'IRR',0,'[]',datetime('now'),datetime('now')),
('plan-station-annual','charging_station_annual','عضویت سالانه ایستگاه شارژ','charging_station',365,0,'IRR',0,'[]',datetime('now'),datetime('now')),
('plan-repair-shop-annual','repair_shop_annual','عضویت سالانه تعمیرگاه','repair_shop',365,0,'IRR',0,'[]',datetime('now'),datetime('now'));
