-- REV subscriptions and payment requests. Additive migration only.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS rev_payment_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_code TEXT NOT NULL CHECK(plan_code IN ('navigation_monthly','navigation_yearly')),
  amount_toman INTEGER NOT NULL CHECK(amount_toman > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reference TEXT,
  admin_note TEXT,
  verified_by TEXT,
  FOREIGN KEY(user_id) REFERENCES rev_users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rev_payment_orders_user ON rev_payment_orders(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_rev_payment_orders_status ON rev_payment_orders(status,created_at);
CREATE TABLE IF NOT EXISTS rev_user_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_code TEXT NOT NULL CHECK(plan_code IN ('navigation_monthly','navigation_yearly')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','cancelled')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual_review',
  payment_order_id TEXT,
  FOREIGN KEY(user_id) REFERENCES rev_users(id) ON DELETE CASCADE,
  FOREIGN KEY(payment_order_id) REFERENCES rev_payment_orders(id)
);
CREATE INDEX IF NOT EXISTS idx_rev_subscriptions_access ON rev_user_subscriptions(user_id,status,starts_at,ends_at);
