-- Apply once to existing sandbox and live D1 databases before deploying the Worker.
CREATE TABLE IF NOT EXISTS stripe_refund_state (
  payment_intent_id TEXT PRIMARY KEY,
  payment_status TEXT NOT NULL CHECK (payment_status IN ('refunded', 'partially_refunded')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
