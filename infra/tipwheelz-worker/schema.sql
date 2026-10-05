CREATE TABLE IF NOT EXISTS payment_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  flow TEXT NOT NULL CHECK (flow IN ('one_time', 'monthly')),
  tier TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  donor_email TEXT NOT NULL,
  donor_name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  wall_of_thanks_consent INTEGER NOT NULL DEFAULT 0 CHECK (wall_of_thanks_consent IN (0, 1)),
  payment_status TEXT NOT NULL,
  subscription_status TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS payment_ledger_subscription ON payment_ledger(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS payment_ledger_intent ON payment_ledger(stripe_payment_intent_id);
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS stripe_refund_state (
  payment_intent_id TEXT PRIMARY KEY,
  payment_status TEXT NOT NULL CHECK (payment_status IN ('refunded', 'partially_refunded')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS checkout_rate (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
