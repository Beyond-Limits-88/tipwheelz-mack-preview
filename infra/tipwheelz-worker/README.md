# TipWheelz Checkout Worker

TipWheelz runs separate Cloudflare Workers and D1 databases for sandbox and live payments. The public GitHub Pages site uses `tipwheelz-live`; the Mack sandbox preview uses `tipwheelz-wall`. Do not copy keys, webhook signing secrets, or donor records between them.

The Worker maps nine tier keys to server-side Stripe Prices, creates custom Checkout Sessions, verifies raw-body webhook signatures, records a private ledger, and serves the opt-in Wall of Thanks. The public `/wall` response contains names only. The authenticated admin endpoint returns amounts and private notes. Admin authentication uses the `WALL_ADMIN_TOKEN` secret; the page URL itself is not an access control.

## D1 schema and migrations

For a new database, apply `schema.sql` and the Wall of Thanks schema, then `wall-admin-index.sql`. For an existing database, apply `refund-state-migration.sql` before deploying a Worker that uses `stripe_refund_state`.

The refund state table keeps `charge.refunded` authoritative even when Stripe events arrive out of order. After migrating an existing database, backfill any known refunds:

```sql
INSERT OR IGNORE INTO stripe_refund_state (payment_intent_id, payment_status)
SELECT stripe_payment_intent_id, payment_status FROM payment_ledger
WHERE stripe_payment_intent_id IS NOT NULL
AND payment_status IN ('refunded','partially_refunded');
```

Sandbox and live databases were migrated independently on October 5, 2026. The sandbox $5 refunded entry was backfilled. Keep this migration in new deployments and restore procedures.

## Security checks

Run `node worker.security.test.mjs` and `node worker.test.mjs` after changing checkout, webhook, refund, or wall logic. The security suite uses an in-memory SQLite database and signed mock Stripe events. It checks access controls, public/private data separation, signature rejection, out-of-order refunds, invalid inputs, and the checkout rate limit. These tests do not replace an external assessment or a real Stripe sandbox purchase.

The sandbox checkout is at `https://app.macknified.com/p/Vz3RFJjv`; the live public site is at `https://manthey1-crypto.github.io/tipwheelz-mack-preview/`. The live admin page is `/wall-admin-live/` and the sandbox admin remains in Mack at `https://app.macknified.com/p/WYZfRwv`. Do not use Mack's “sync all” for the GitHub repository because it may restore deleted sandbox paths.

Keep `STRIPE_SECRET_KEY` or `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `WALL_ADMIN_TOKEN`, `PORTAL_TOKEN_SECRET`, and `RATE_LIMIT_SALT` only in Cloudflare secrets. The `pk_live_` and `pk_test_` publishable keys belong in the respective browser pages. Billing Portal tokens are signed, tied to a verified monthly ledger record, and expire after 180 days; supporters who lose access should contact `info@rollflow.net`.
