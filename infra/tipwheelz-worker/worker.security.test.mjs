import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from './worker.js';

const origin = 'https://app.macknified.com';
const adminToken = 'a'.repeat(64);
const sessionId = 'cs_test_ABCDEFGHIJKLMN';
const pi = 'pi_ABCDEFGHIJKLMN';
const subscription = 'sub_ABCDEFGHIJKLMN';
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  db.exec(`CREATE TABLE wall_entries (
    id TEXT PRIMARY KEY, payment_reference TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    message TEXT, tier TEXT, consent_recorded_at TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0, featured_until TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const DB = {prepare(sql) {
    const statement=db.prepare(sql);
    const wrapped=(values=[])=>({
      bind(...next){return wrapped(next)},
      first: async () => statement.get(...values) || null,
      all: async () => ({results: statement.all(...values)}),
      run: async () => ({meta:{changes: statement.run(...values).changes}}),
    });
    return wrapped();
  }};
  const env = {DB,STRIPE_API_KEY:'rk_test_mock',STRIPE_WEBHOOK_SECRET:'whsec_mock',
    RATE_LIMIT_SALT:'mock-salt',PORTAL_TOKEN_SECRET:'mock-portal-secret',
    PORTAL_RETURN_URL:origin,RETURN_URL:origin+'/thanks',WALL_ADMIN_TOKEN:adminToken};
  return {db,env};
}

async function webhook(env, id, type, object, {sign=true, livemode=false, timestamp=Math.floor(Date.now()/1000)}={}) {
  const body=JSON.stringify({id,type,livemode,data:{object}});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}.${body}`)));
  const signature=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
  return worker.fetch(new Request('https://example.com/api/tipwheelz/webhook',{method:'POST',
    headers:{'Stripe-Signature':`t=${timestamp},v1=${sign?signature:'0'.repeat(64)}`},body}),env);
}

function checkoutObject({flow='monthly',tier='monthly_3',consent=true, note='<img src=x onerror=alert(1)>'}={}) {
  return {id:sessionId,payment_intent:pi,subscription:flow==='monthly'?subscription:null,
    customer:'cus_ABCDEFGHIJKLMN',amount_total:flow==='monthly'?300:500,currency:'usd',payment_status:'paid',
    customer_email:'security-test@example.invalid',metadata:{tipwheelz_flow:flow,tipwheelz_tier:tier,
      tipwheelz_name:'Security Test',tipwheelz_message:note,tipwheelz_wall_of_thanks_consent:String(consent)}};
}

function api(path, {method='GET',body,token,requestOrigin=origin,headers={}}={}) {
  return new Request('https://example.com'+path,{method,headers:{Origin:requestOrigin,
    ...(token?{Authorization:'Bearer '+token}:{}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
}

test('admin and public wall enforce separate data access',async()=>{
  const {db,env}=setup();
  assert.equal((await webhook(env,'evt_1','checkout.session.completed',checkoutObject())).status,200);
  const adminPath='/api/tipwheelz/admin/wall';
  assert.equal((await worker.fetch(api(adminPath),env)).status,401);
  assert.equal((await worker.fetch(api(adminPath,{token:adminToken,requestOrigin:'https://attacker.example'}),env)).status,403);
  const admin=await (await worker.fetch(api(adminPath,{token:adminToken}),env)).json();
  assert.equal(admin.entries[0].note,'<img src=x onerror=alert(1)>');
  const published=await worker.fetch(api(adminPath,{method:'POST',token:adminToken,
    body:{action:'publish',sessionId,displayName:'Public Name'}}),env);
  assert.equal(published.status,200);
  const wall=await (await worker.fetch(api('/wall'),env)).json();
  assert.deepEqual(wall,{entries:[{name:'Public Name'}]});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stripe_events').get().n,1);
  assert.equal((await webhook(env,'evt_1','checkout.session.completed',checkoutObject())).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stripe_events').get().n,1);
  db.close();
});

test('invalid webhook signatures, stale timestamps and cross-mode events fail',async()=>{
  const {db,env}=setup();
  assert.equal((await webhook(env,'evt_2','checkout.session.completed',checkoutObject(),{sign:false})).status,400);
  assert.equal((await webhook(env,'evt_3','checkout.session.completed',checkoutObject(),{timestamp:Math.floor(Date.now()/1000)-400})).status,400);
  assert.equal((await webhook(env,'evt_4','checkout.session.completed',checkoutObject(),{livemode:true})).status,400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
  db.close();
});

test('refund cannot be undone by later invoice webhook',async()=>{
  const {db,env}=setup();
  await webhook(env,'evt_5','checkout.session.completed',checkoutObject());
  await worker.fetch(api('/api/tipwheelz/admin/wall',{method:'POST',token:adminToken,
    body:{action:'publish',sessionId,displayName:'Refunded Name'}}),env);
  await webhook(env,'evt_6','charge.refunded',{payment_intent:pi,amount:300,amount_refunded:300});
  assert.deepEqual((await (await worker.fetch(api('/wall'),env)).json()).entries,[]);
  await webhook(env,'evt_7','invoice.paid',{subscription});
  assert.deepEqual((await (await worker.fetch(api('/wall'),env)).json()).entries,[]);
  await webhook(env,'evt_7b','invoice.payment_failed',{subscription});
  assert.deepEqual((await (await worker.fetch(api('/wall'),env)).json()).entries,[]);
  db.close();
});

test('out-of-order refund stays refunded after checkout completion',async()=>{
  const {db,env}=setup();
  await webhook(env,'evt_8','charge.refunded',{payment_intent:pi,amount:300,amount_refunded:300});
  await webhook(env,'evt_9','checkout.session.completed',checkoutObject());
  assert.equal(db.prepare('SELECT payment_status FROM payment_ledger').get()?.payment_status,'refunded');
  db.close();
});

test('late partial refund cannot downgrade a full refund',async()=>{
  const {db,env}=setup();
  await webhook(env,'evt_10','charge.refunded',{payment_intent:pi,amount:300,amount_refunded:300});
  await webhook(env,'evt_11','charge.refunded',{payment_intent:pi,amount:300,amount_refunded:100});
  await webhook(env,'evt_12','checkout.session.completed',checkoutObject());
  assert.equal(db.prepare('SELECT payment_status FROM payment_ledger').get().payment_status,'refunded');
  db.close();
});

test('invalid checkout details and foreign origins are rejected before Stripe',async()=>{
  const {db,env}=setup();
  let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({id:sessionId,client_secret:'mock_secret'})};
  const body={flow:'one_time',tier:'tip_5',email:'security-test@example.invalid',
    name:'Test',message:'',wallOfThanksConsent:false};
  const path='/api/tipwheelz/checkout-session';
  const idempotency='a49be9f1-75fb-49af-a450-896cd2d1d1de';
  async function submit(fields,requestOrigin=origin){return worker.fetch(api(path,{method:'POST',body:fields,requestOrigin,
    headers:{'Idempotency-Key':idempotency,'Content-Type':'application/json'}}),env)}
  assert.equal((await submit({...body,tier:'tip_999'})).status,400);
  assert.equal((await submit({...body,message:'x'.repeat(501)})).status,400);
  assert.equal((await submit(body,'https://attacker.example')).status,403);
  assert.equal(calls,0);
  for(let i=0;i<20;i++)assert.equal((await submit(body)).status,200);
  assert.equal((await submit(body)).status,429);
  assert.equal(calls,20);
  db.close();
});
