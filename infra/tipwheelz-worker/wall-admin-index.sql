-- Run after the wall_entries table exists. One wall entry per verified session.
CREATE UNIQUE INDEX IF NOT EXISTS wall_entries_payment_reference_unique
ON wall_entries(payment_reference);
