import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const origin = 'https://app.macknified.com';
const savedFetch = globalThis.fetch;
function setup(mode='sandbox') {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, params:new URLSearchParams(options.body)});
    if (url.endsWith('/billing_portal/sessions')) return Response.json({url:'https://billing.stripe.com/p/test'});
    return Response.json({id:mode==='live'?'cs_live_ABCDEFGHIJKL':'cs_test_ABCDEFGHIJKL',client_secret:'cs_secret_test'});
  };
  const env = {
    DEPLOYMENT_MODE:mode, STRIPE_API_KEY:mode==='live'?'rk_live_example':'rk_test_example',
    RETURN_URL:'https://example.com/thanks?session_id={CHECKOUT_SESSION_ID}',
    PORTAL_RETURN_URL:'https://example.com/',PORTAL_TOKEN_SECRET:'a'.repeat(64),RATE_LIMIT_SALT:'test-salt',
    DB:{prepare(sql){return {bind(...args){return {first:async()=>sql.includes('checkout_rate')?{count:1}:{stripe_customer_id:'cus_verified'}}}}}}
  };
  return {env,calls};
}
function request(path,body,headers={}) {
  return new Request('https://worker.example'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':'a49be9f1-75fb-49af-a450-896cd2d1d1de',...headers},body:JSON.stringify(body)});
}
const supporter={flow:'monthly',tier:'monthly_30',email:'Test@Example.com',name:'Test',message:'',wallOfThanksConsent:true};

test('monthly session uses server price and returns a signed portal token', async () => {
  const {env,calls}=setup();
  const response=await worker.fetch(request('/api/tipwheelz/checkout-session',{...supporter,amount:1,price:'fake'}),env);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.match(body.managementToken,/^cs_test_.*\.[0-9a-f]{64}$/);
  assert.equal(calls[0].params.get('line_items[0][price]'),'price_1UMJJlAmw5QsPEyVqLHRWcaq');
  assert.equal(calls[0].params.get('mode'),'subscription');
  assert.equal(calls[0].params.get('customer_email'),'test@example.com');
  const portal=await worker.fetch(request('/api/tipwheelz/billing-portal',{token:body.managementToken,customer:'cus_attacker'}),env);
  assert.equal(portal.status,200);
  assert.equal(calls[1].params.get('customer'),'cus_verified');
  assert.equal((await portal.json()).url,'https://billing.stripe.com/p/test');
});

test('invalid support inputs, origin, and portal token are rejected',async()=>{
  const {env,calls}=setup();
  assert.equal((await worker.fetch(request('/api/tipwheelz/checkout-session',{...supporter,flow:'one_time'}),env)).status,400);
  assert.equal((await worker.fetch(request('/api/tipwheelz/checkout-session',{...supporter,name:'x'.repeat(101)}),env)).status,400);
  assert.equal((await worker.fetch(request('/api/tipwheelz/checkout-session',supporter,{Origin:'https://evil.example'}),env)).status,403);
  assert.equal((await worker.fetch(request('/api/tipwheelz/billing-portal',{token:'cs_test_ABCDEFGHIJKL.1999999999.'+'0'.repeat(64)}),env)).status,403);
  assert.equal(calls.length,0);
});

test('production remains off until every live price and key are configured',async()=>{
  const {env,calls}=setup('live');
  assert.equal((await worker.fetch(request('/api/tipwheelz/checkout-session',supporter),env)).status,503);
  assert.equal(calls.length,0);
});

test.after(()=>{globalThis.fetch=savedFetch});
