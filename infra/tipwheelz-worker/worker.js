// TipWheelz API. Sandbox and live deployments use separate Workers and D1 databases.
const SANDBOX_ORIGINS = ['https://app.macknified.com', 'https://manthey1-crypto.github.io'];
const SANDBOX_PRICES = {
  tip_5: ['one_time', 'price_1UMJJ8Amw5QsPEyV6CsIcKaX', 500],
  tip_10: ['one_time', 'price_1UMJJDAmw5QsPEyVXSTSx0T1', 1000],
  tip_25: ['one_time', 'price_1UMJJMAmw5QsPEyVlG9it8jF', 2500],
  tip_50: ['one_time', 'price_1UMJJHAmw5QsPEyVpK72Iffb', 5000],
  tip_100: ['one_time', 'price_1UMJJRAmw5QsPEyVhWy4MbH4', 10000],
  monthly_3: ['monthly', 'price_1UMJJVAmw5QsPEyVtWe4r8CD', 300],
  monthly_7: ['monthly', 'price_1UMJJZAmw5QsPEyVqpRRbKHr', 700],
  monthly_15: ['monthly', 'price_1UMJJfAmw5QsPEyVH22fcxs6', 1500],
  monthly_30: ['monthly', 'price_1UMJJlAmw5QsPEyVqLHRWcaq', 3000],
};
const TIER_AMOUNTS = {tip_5:500, tip_10:1000, tip_25:2500, tip_50:5000, tip_100:10000, monthly_3:300, monthly_7:700, monthly_15:1500, monthly_30:3000};
function origins(env) { return new Set((env.ALLOWED_ORIGINS || SANDBOX_ORIGINS.join(',')).split(',').map(s => s.trim()).filter(Boolean)); }
function prices(env) {
  if (env.DEPLOYMENT_MODE !== 'live') return SANDBOX_PRICES;
  return Object.fromEntries(Object.entries(TIER_AMOUNTS).map(([tier, amount]) => [tier, [tier.startsWith('tip_') ? 'one_time' : 'monthly', env[`STRIPE_PRICE_${tier.toUpperCase()}`], amount]]));
}
function configured(env) {
  const live = env.DEPLOYMENT_MODE === 'live';
  const key = env.STRIPE_API_KEY || '';
  return Boolean(env.RATE_LIMIT_SALT && (live ? env.RETURN_URL : true) &&
    (live ? /^rk_live_/.test(key) : /^(rk_test_|sk_test_)/.test(key)) &&
    Object.values(prices(env)).every(p => /^price_[A-Za-z0-9]+$/.test(p[1])));
}
const encoder = new TextEncoder();
const headersFor = (origin, env) => ({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  ...(origins(env).has(origin) ? {'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, Idempotency-Key, Authorization', 'vary': 'Origin'} : {}),
});
function json(body, status = 200, origin = '', env = {}) {
  return new Response(JSON.stringify(body), {status, headers: headersFor(origin, env)});
}
function safeText(value, max) {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
}
function formField(params, key, value) {
  if (value !== undefined && value !== null) params.append(key, String(value));
}
async function stripePost(env, path, params, idempotency) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_API_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2026-08-26.dahlia',
      ...(idempotency ? {'Idempotency-Key': idempotency} : {}),
    },
    body: params,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${data.error?.type || 'unknown'}`);
  return data;
}
async function portalToken(env, sessionId, expires) {
  const payload = `${sessionId}.${expires}`;
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.PORTAL_TOKEN_SECRET), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `${payload}.${Array.from(signature, b => b.toString(16).padStart(2,'0')).join('')}`;
}
async function billingPortal(request, env, origin) {
  if (!configured(env) || !env.PORTAL_TOKEN_SECRET || !env.PORTAL_RETURN_URL) return json({error:'Billing management is unavailable'},503,origin,env);
  if (Number(request.headers.get('content-length') || 0) > 1000) return json({error:'Invalid request'},400,origin,env);
  let input;
  try { const raw = await request.text(); if (raw.length > 1000) throw new Error('oversized'); input = JSON.parse(raw); } catch { return json({error:'Invalid request'},400,origin,env); }
  const token = input?.token;
  const match = typeof token === 'string' && token.match(/^(cs_(?:test|live)_[A-Za-z0-9]{10,128})\.(\d{10})\.([0-9a-f]{64})$/);
  if (!match || (env.DEPLOYMENT_MODE === 'live') !== match[1].startsWith('cs_live_') || Number(match[2]) < Date.now()/1000) return json({error:'Invalid or expired access'},403,origin,env);
  const expected = await portalToken(env, match[1], match[2]);
  if (!constantEqual(bytes(match[3]), bytes(expected.split('.').at(-1)))) return json({error:'Invalid or expired access'},403,origin,env);
  const row = await env.DB.prepare('SELECT stripe_customer_id FROM payment_ledger WHERE stripe_session_id=? AND flow=? AND stripe_customer_id IS NOT NULL AND payment_status=?').bind(match[1], 'monthly', 'paid').first();
  if (!row) return json({error:'No active billing record found'},404,origin,env);
  const params = new URLSearchParams({customer: row.stripe_customer_id, return_url:env.PORTAL_RETURN_URL});
  const portal = await stripePost(env, 'billing_portal/sessions', params);
  return json({url:portal.url},200,origin,env);
}
async function limitRequest(request, env) {
  // D1 is a shared store across Worker instances. Only a one-way hash is retained.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${day}:${ip}:${env.RATE_LIMIT_SALT}`))))
    .map(x => x.toString(16).padStart(2, '0')).join('');
  const result = await env.DB.prepare(`INSERT INTO checkout_rate (key, window_start, count) VALUES (?, unixepoch(), 1)
    ON CONFLICT(key) DO UPDATE SET window_start=CASE WHEN unixepoch()-window_start>3600 THEN unixepoch() ELSE window_start END,
      count=CASE WHEN unixepoch()-window_start>3600 THEN 1 ELSE count+1 END RETURNING count`)
    .bind(key).first();
  return result.count <= 20;
}
async function checkout(request, env, origin) {
  if (!configured(env)) return json({error: 'Checkout is not configured'}, 503, origin, env);
  if (!env.PORTAL_TOKEN_SECRET || !env.PORTAL_RETURN_URL) return json({error:'Checkout is not configured'},503,origin,env);
  if (Number(request.headers.get('content-length') || 0) > 4000) return json({error: 'Invalid request'}, 400, origin, env);
  let input;
  try { const raw = await request.text(); if (raw.length > 4000) throw new Error('oversized'); input = JSON.parse(raw); } catch { return json({error: 'Invalid request'}, 400, origin, env); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return json({error: 'Invalid request'}, 400, origin, env);
  const choices = prices(env);
  const choice = Object.hasOwn(choices, input.tier) ? choices[input.tier] : null;
  const email = safeText(input.email, 254)?.toLowerCase();
  const name = input.name === undefined ? '' : safeText(input.name, 100);
  const message = input.message === undefined ? '' : safeText(input.message, 500);
  const consent = input.wallOfThanksConsent === undefined ? false : input.wallOfThanksConsent;
  if (!choice || choice[0] !== input.flow || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || name === null || message === null || typeof consent !== 'boolean') {
    return json({error: 'Invalid support details'}, 400, origin, env);
  }
  const idempotency = request.headers.get('Idempotency-Key');
  if (!idempotency || !/^[0-9a-f-]{36}$/i.test(idempotency)) return json({error: 'Idempotency key required'}, 400, origin, env);
  if (!(await limitRequest(request, env))) return json({error: 'Please try again later'}, 429, origin, env);
  const params = new URLSearchParams();
  formField(params, 'mode', choice[0] === 'monthly' ? 'subscription' : 'payment');
  formField(params, 'ui_mode', 'elements');
  formField(params, 'line_items[0][price]', choice[1]);
  formField(params, 'line_items[0][quantity]', 1);
  formField(params, 'customer_email', email);
  formField(params, 'return_url', env.RETURN_URL || 'https://app.macknified.com/p/zJugqV?session_id={CHECKOUT_SESSION_ID}');
  // Stripe compares every parameter on an idempotent retry, including this label.
  const labelSuffix = idempotency.replace(/-/g, '').slice(0, 8).split('').map(x => 'abcdefghijklmnop'[parseInt(x, 16)]).join('');
  formField(params, 'integration_identifier', `tipwheelz_${labelSuffix}`);
  const metadata = {tipwheelz_flow: choice[0], tipwheelz_tier: input.tier, tipwheelz_name: name, tipwheelz_message: message, tipwheelz_wall_of_thanks_consent: String(consent)};
  for (const [k, v] of Object.entries(metadata)) {
    formField(params, `metadata[${k}]`, v);
    formField(params, `${choice[0] === 'monthly' ? 'subscription_data' : 'payment_intent_data'}[metadata][${k}]`, v);
  }
  const session = await stripePost(env, 'checkout/sessions', params, `tipwheelz-${idempotency}`);
  const managementToken = choice[0] === 'monthly' ? await portalToken(env, session.id, Math.floor(Date.now()/1000)+180*86400) : null;
  return json({clientSecret: session.client_secret, sessionId: session.id, managementToken}, 200, origin, env);
}
function bytes(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return null;
  return Uint8Array.from(hex.match(/.{2}/g), s => parseInt(s, 16));
}
function constantEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function verifyWebhook(request, secret, raw) {
  const header = request.headers.get('Stripe-Signature') || '';
  const timestamp = Number(header.match(/(?:^|,)t=(\d+)/)?.[1]);
  const signatures = [...header.matchAll(/(?:^|,)v1=([0-9a-f]+)/gi)].map(x => bytes(x[1]));
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300 || !signatures.length) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${raw}`)));
  return signatures.some(s => constantEqual(s, expected));
}
async function webhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({error: 'Unavailable'}, 503);
  const raw = await request.text();
  if (raw.length > 1000000 || !(await verifyWebhook(request, env.STRIPE_WEBHOOK_SECRET, raw))) return json({error: 'Invalid signature'}, 400);
  let event;
  try { event = JSON.parse(raw); } catch { return json({error: 'Invalid event'}, 400); }
  if (!event.id || !event.type || !event.data?.object || event.livemode !== (env.DEPLOYMENT_MODE === 'live')) return json({error: 'Invalid event'}, 400);
  if (await env.DB.prepare('SELECT id FROM stripe_events WHERE id=?').bind(event.id).first()) return json({received:true});
  const obj = event.data.object;
  const choices = prices(env);
  // A session is tagged by this Worker. Other Stripe account activity is ignored.
  if (event.type.startsWith('checkout.session.')) {
    if (!obj.metadata?.tipwheelz_tier || !Object.hasOwn(choices, obj.metadata.tipwheelz_tier)) return json({received: true});
    const meta = obj.metadata;
    const paid = event.type === 'checkout.session.async_payment_succeeded' || (event.type === 'checkout.session.completed' && obj.payment_status === 'paid');
    const status = event.type === 'checkout.session.async_payment_failed' ? 'failed' : paid ? 'paid' : 'pending';
    await env.DB.prepare(`INSERT INTO payment_ledger (stripe_session_id, stripe_payment_intent_id, stripe_customer_id, stripe_subscription_id, flow, tier, amount, currency, donor_email, donor_name, message, wall_of_thanks_consent, payment_status, subscription_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(stripe_session_id) DO UPDATE SET stripe_payment_intent_id=COALESCE(excluded.stripe_payment_intent_id, payment_ledger.stripe_payment_intent_id),
      stripe_customer_id=COALESCE(excluded.stripe_customer_id, payment_ledger.stripe_customer_id),
      stripe_subscription_id=COALESCE(excluded.stripe_subscription_id, payment_ledger.stripe_subscription_id),
      payment_status=CASE WHEN payment_ledger.payment_status='refunded' OR (excluded.payment_status='pending' AND payment_ledger.payment_status='paid') THEN payment_ledger.payment_status ELSE excluded.payment_status END,
      updated_at=CURRENT_TIMESTAMP`)
      .bind(obj.id, obj.payment_intent || null, obj.customer || null, obj.subscription || null, meta.tipwheelz_flow, meta.tipwheelz_tier, obj.amount_total ?? choices[meta.tipwheelz_tier][2], obj.currency || 'usd', obj.customer_details?.email || obj.customer_email || '', meta.tipwheelz_name || '', meta.tipwheelz_message || '', meta.tipwheelz_wall_of_thanks_consent === 'true' ? 1 : 0, status, obj.subscription ? 'active' : null).run();
  } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const sub = typeof obj.subscription === 'string' ? obj.subscription : obj.parent?.subscription_details?.subscription;
    if (sub) await env.DB.prepare('UPDATE payment_ledger SET payment_status=?, subscription_status=?, updated_at=CURRENT_TIMESTAMP WHERE stripe_subscription_id=?')
      .bind(event.type === 'invoice.paid' ? 'paid' : 'failed', event.type === 'invoice.paid' ? 'active' : 'past_due', sub).run();
  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    await env.DB.prepare('UPDATE payment_ledger SET subscription_status=?, updated_at=CURRENT_TIMESTAMP WHERE stripe_subscription_id=?')
      .bind(obj.status || 'canceled', obj.id).run();
  } else if (event.type === 'charge.refunded') {
    const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
    if (pi) await env.DB.prepare('UPDATE payment_ledger SET payment_status=?, updated_at=CURRENT_TIMESTAMP WHERE stripe_payment_intent_id=?').bind('refunded', pi).run();
  } else if (event.type === 'payment_intent.payment_failed') {
    await env.DB.prepare('UPDATE payment_ledger SET payment_status=?, updated_at=CURRENT_TIMESTAMP WHERE stripe_payment_intent_id=?').bind('failed', obj.id).run();
  }
  await env.DB.prepare('INSERT OR IGNORE INTO stripe_events (id, event_type) VALUES (?, ?)').bind(event.id, event.type).run();
  return json({received: true});
}
async function isWallAdmin(request, env) {
  const supplied = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];
  if (!supplied || !env.WALL_ADMIN_TOKEN) return false;
  const [actual, expected] = await Promise.all([supplied, env.WALL_ADMIN_TOKEN].map(s => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  return constantEqual(new Uint8Array(actual), new Uint8Array(expected));
}
async function adminWall(request, env, origin) {
  if (!(await isWallAdmin(request, env))) return json({error: 'Unauthorized'}, 401, origin, env);
  if (request.method === 'GET') {
    const {results} = await env.DB.prepare(`SELECT l.stripe_session_id AS sessionId, l.donor_name AS submittedName,
      l.amount, l.currency, l.flow, l.tier, l.payment_status AS paymentStatus,
      l.wall_of_thanks_consent AS consent, w.display_name AS displayName, w.approved
      FROM payment_ledger l LEFT JOIN wall_entries w ON w.payment_reference=l.stripe_session_id
      ORDER BY l.created_at DESC LIMIT 100`).all();
    return json({entries: results}, 200, origin, env);
  }
  if (request.method !== 'POST') return json({error: 'Not found'}, 404, origin, env);
  if (Number(request.headers.get('content-length') || 0) > 2000) return json({error: 'Invalid request'}, 400, origin, env);
  let input;
  try { const raw = await request.text(); if (raw.length > 2000) throw new Error('oversized'); input = JSON.parse(raw); } catch { return json({error: 'Invalid request'}, 400, origin, env); }
  const sessionId = input?.sessionId;
  const action = input?.action;
  const sessionPattern = env.DEPLOYMENT_MODE === 'live' ? /^cs_live_[A-Za-z0-9]{10,128}$/ : /^cs_test_[A-Za-z0-9]{10,128}$/;
  if (typeof sessionId !== 'string' || !sessionPattern.test(sessionId) || !['publish','edit','remove'].includes(action)) return json({error: 'Invalid request'}, 400, origin, env);
  const name = action === 'remove' ? null : safeText(input.displayName, 100);
  if (action !== 'remove' && (!name || name.length > 100)) return json({error: 'Valid display name required'}, 400, origin, env);
  if (action === 'remove') {
    const result = await env.DB.prepare('UPDATE wall_entries SET approved=0 WHERE payment_reference=?').bind(sessionId).run();
    return json({ok: true, changed: result.meta.changes}, 200, origin, env);
  }
  // Only a paid, consenting TipWheelz ledger row can reach the public wall.
  const result = await env.DB.prepare(`INSERT INTO wall_entries (id, payment_reference, display_name, message, tier, consent_recorded_at, approved)
    SELECT 'wall_' || stripe_session_id, stripe_session_id, ?, NULL, tier, created_at, 1
    FROM payment_ledger WHERE stripe_session_id=? AND wall_of_thanks_consent=1 AND payment_status='paid'
    ON CONFLICT(payment_reference) DO UPDATE SET display_name=excluded.display_name, approved=1`).bind(name, sessionId).run();
  if (!result.meta.changes) return json({error: 'Paid consented payment required'}, 409, origin, env);
  return json({ok: true}, 200, origin, env);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    try {
      if (request.method === 'GET' && url.pathname === '/health') return json({ok: true});
      if (request.method === 'GET' && url.pathname === '/wall') {
        if (origin && !origins(env).has(origin)) return json({error: 'Origin not allowed'}, 403);
        const {results} = await env.DB.prepare(`SELECT w.display_name AS name
          FROM wall_entries w JOIN payment_ledger l ON l.stripe_session_id=w.payment_reference
          WHERE w.approved = 1 AND w.consent_recorded_at IS NOT NULL
          AND l.wall_of_thanks_consent=1 AND l.payment_status='paid'
          AND (w.featured_until IS NULL OR datetime(w.featured_until) > datetime('now'))
          ORDER BY w.created_at DESC LIMIT 100`).all();
        return json({entries: results}, 200, origin, env);
      }
      if (url.pathname === '/api/tipwheelz/webhook' && request.method === 'POST') return await webhook(request, env);
      if (url.pathname === '/api/tipwheelz/health' && request.method === 'GET') return json({ok: true, mode: env.DEPLOYMENT_MODE || 'sandbox', checkoutConfigured: configured(env), webhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET)});
      if (!origins(env).has(origin)) return json({error: 'Origin not allowed'}, 403);
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: headersFor(origin, env)});
      if (url.pathname === '/api/tipwheelz/admin/wall') return await adminWall(request, env, origin);
      if (url.pathname === '/api/tipwheelz/status' && request.method === 'GET') {
        const sessionId = url.searchParams.get('session_id') || '';
        if (!(env.DEPLOYMENT_MODE === 'live' ? /^cs_live_[A-Za-z0-9]{10,128}$/ : /^cs_test_[A-Za-z0-9]{10,128}$/).test(sessionId)) return json({error: 'Invalid session'}, 400, origin, env);
        const row = await env.DB.prepare('SELECT payment_status, flow FROM payment_ledger WHERE stripe_session_id=?').bind(sessionId).first();
        return json({status: row?.payment_status || 'pending', flow: row?.flow || null}, 200, origin, env);
      }
      if (url.pathname === '/api/tipwheelz/checkout-session' && request.method === 'POST') return await checkout(request, env, origin);
      if (url.pathname === '/api/tipwheelz/billing-portal' && request.method === 'POST') return await billingPortal(request, env, origin);
      return json({error: 'Not found'}, 404, origin, env);
    } catch (e) {
      console.error('TipWheelz API error:', e instanceof Error ? e.message : String(e));
      return json({error: 'Unable to process this request'}, 500, origin, env);
    }
  },
};
