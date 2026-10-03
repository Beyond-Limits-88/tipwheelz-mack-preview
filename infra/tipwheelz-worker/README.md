# TipWheelz Checkout Worker

The active sandbox API and Wall of Thanks are deployed together at
`https://tipwheelz-wall.tipwheelz-rollflow.workers.dev`.

The D1 database `tipwheelz-db` holds `payment_ledger`, `stripe_events`,
`checkout_rate`, and moderated `wall_entries` tables. `schema.sql` creates
the first three; `wall-admin-index.sql` adds a unique index after the wall
table exists. The public `/wall` endpoint returns only names for paid,
consenting, approved entries.

The Roll Flow sandbox webhook sends signed events to
`/api/tipwheelz/webhook`. The Worker has `STRIPE_API_KEY` (`rk_test_` or
`sk_test_`), `STRIPE_WEBHOOK_SECRET`, and `RATE_LIMIT_SALT` as secrets.
Keep these out of page HTML and source files. The former standalone
`tipwheelz-checkout-sandbox` Worker is not used by the preview page.

The API supports nine allowlisted tiers: five one-time and four monthly.
`POST /api/tipwheelz/checkout-session` creates a Checkout Session in Elements
mode and returns a client secret. The browser also needs the Roll Flow sandbox
`pk_test_` publishable key. `GET /api/tipwheelz/status?session_id=...` returns
only the webhook ledger's payment status and flow. The billing portal route
requires a signed, expiring token returned with a monthly Checkout Session.
It resolves the Stripe customer ID from a paid D1 ledger entry; the client
cannot choose a customer ID. A supporter who changes devices or loses the
token should contact info@rollflow.net. The token expires after 180 days.

## Live preparation

The separate `tipwheelz-live` Worker is uploaded with a separate, empty
`tipwheelz-live-db` D1 database. Its workers.dev subdomain is disabled and its
checkout is unconfigured. Do not point the public page at it yet.

Before enabling live checkout, add all nine live `STRIPE_PRICE_TIP_5`,
`STRIPE_PRICE_TIP_10`, `STRIPE_PRICE_TIP_25`, `STRIPE_PRICE_TIP_50`,
`STRIPE_PRICE_TIP_100`, `STRIPE_PRICE_MONTHLY_3`, `STRIPE_PRICE_MONTHLY_7`,
`STRIPE_PRICE_MONTHLY_15`, and `STRIPE_PRICE_MONTHLY_30` bindings. The last
price ($30/month) has not been created yet because Stripe's automatic approval
review hit a usage limit. Set `STRIPE_API_KEY` to a live restricted key with
Checkout Session and Billing Portal session creation permissions, plus
`STRIPE_WEBHOOK_SECRET` as production secrets. Independent production
`RATE_LIMIT_SALT` and `PORTAL_TOKEN_SECRET` values are already installed;
do not copy their sandbox counterparts. The Stripe live webhook must target
`/api/tipwheelz/webhook` on the live Worker. Set `RETURN_URL`,
`PORTAL_RETURN_URL`, and `ALLOWED_ORIGINS` to the final HTTPS site.

The page needs a `pk_live_` key only when the production Worker, live webhook,
live Prices, portal, and end-to-end sandbox cases have passed. Keep the
`pk_test_` preview at `/checkout-preview/` until then. Do not put restricted or
secret keys into HTML or GitHub. Subscription tax treatment should be reviewed
in Stripe before launch; enabling automatic tax without an active registration
does not collect tax.

Custom Mack preview: `https://app.macknified.com/p/Vz3RFJjv`.
Its `PUBLISHABLE_KEY` constant contains the public sandbox key. The original Mack sandbox page remains at
`https://app.macknified.com/p/SALciv6U`. Session creation was verified for
one-time and monthly tiers. Card confirmation and signed webhook delivery
still need end-to-end testing.

The return page at `https://app.macknified.com/p/zJugqV` stays pending until
a signed webhook records a paid ledger row. Publishing to the Wall of Thanks
requires a separate review of verified payment and explicit consent.

The public wall is `https://app.macknified.com/p/BAYYfwE2` and GitHub
`/wall/`. The admin page is `https://app.macknified.com/p/WYZfRwv` and
GitHub `/wall-admin/`. The admin page contains no credential. It prompts for
the separate `WALL_ADMIN_TOKEN` Worker secret, held only in browser memory,
then calls `GET/POST /api/tipwheelz/admin/wall`. It shows ledger amounts and
can publish, rename, or remove consenting paid entries. The amount is
read-only. The Cloudflare Access product was not enabled on this account at
the time of setup; token access should be replaced with identity-backed
authentication before any live launch.
