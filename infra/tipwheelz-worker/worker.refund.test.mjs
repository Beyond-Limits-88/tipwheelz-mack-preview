import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const origin='https://app.macknified.com';
const token='a'.repeat(64);
const originalFetch=globalThis.fetch;
function makeEnv(){
  const rows={paymentStatus:'paid',paymentIntentId:'pi_ABC123456789',flow:'one_time',tier:'tip_25',amount:2500,currency:'usd'};
  const calls=[];
  const env={
    DEPLOYMENT_MODE:'live',STRIPE_SECRET_KEY:'sk_live_example',RATE_LIMIT_SALT:'salt',
    RETURN_URL:'https://example.com/thanks',WALL_ADMIN_TOKEN:token,
    DB:{prepare(sql){return {bind(...args){return {
      first:async()=>sql.includes('FROM payment_ledger')?{...rows}:null,
      run:async()=>{if(sql.includes('UPDATE payment_ledger'))rows.paymentStatus=args[0];return {meta:{changes:1}}}
    }}}}}
  };
  for(const tier of ['TIP_5','TIP_10','TIP_25','TIP_50','TIP_100','MONTHLY_3','MONTHLY_7','MONTHLY_15','MONTHLY_30'])
    env['STRIPE_PRICE_'+tier]='price_TEST123';
  globalThis.fetch=async(url,options)=>{
    calls.push({url:String(url),options});
    if(String(url).includes('/charges?'))return Response.json({data:[{id:'ch_ABC123456789',payment_intent:rows.paymentIntentId,paid:true,status:'succeeded',amount:2500,amount_refunded:0,currency:'usd'}]});
    if(String(url).endsWith('/refunds'))return Response.json({id:'re_ABC123456789',status:'succeeded',amount:2500,currency:'usd'});
    throw Error('Unexpected Stripe request');
  };
  return {env,calls,rows};
}
function request(action,extra={},auth=token){
  return new Request('https://example.com/api/tipwheelz/admin/refund',{method:'POST',
    headers:{Origin:origin,Authorization:'Bearer '+auth,'Content-Type':'application/json'},
    body:JSON.stringify({action,sessionId:'cs_live_ABCDEFGHIJKL',...extra})});
}
test('live admin previews the exact remaining charge then confirms once',async()=>{
  const {env,calls,rows}=makeEnv();
  let res=await worker.fetch(request('preview'),env);
  assert.equal(res.status,200);
  assert.deepEqual(await res.json(),{amount:2500,currency:'usd',flow:'one_time',tier:'tip_25'});
  assert.equal(calls.length,1);
  res=await worker.fetch(request('confirm',{confirmation:'REFUND',expectedAmount:2500}),env);
  assert.equal(res.status,200);
  assert.equal((await res.json()).status,'succeeded');
  assert.equal(new URLSearchParams(calls[2].options.body).get('charge'),'ch_ABC123456789');
  assert.equal(calls[2].options.headers['Idempotency-Key'],'tipwheelz-admin-refund-ch_ABC123456789');
  assert.equal(rows.paymentStatus,'refunded');
  assert.equal((await worker.fetch(request('confirm',{confirmation:'REFUND',expectedAmount:2500}),env)).status,409);
  assert.equal(calls.length,3);
});
test('unauthorized admin and changed amount never create refunds',async()=>{
  const {env,calls}=makeEnv();
  assert.equal((await worker.fetch(request('confirm',{confirmation:'REFUND',expectedAmount:2500},'b'.repeat(64)),env)).status,401);
  assert.equal((await worker.fetch(request('confirm',{confirmation:'REFUND',expectedAmount:100}),env)).status,409);
  assert.equal(calls.length,1);
});
test.after(()=>{globalThis.fetch=originalFetch});
