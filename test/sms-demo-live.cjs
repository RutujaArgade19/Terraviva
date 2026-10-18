'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const B=require('../lib/backend.cjs'),D=require('../lib/sms-demo.cjs'),route=require('../api/sms-send.js');
test('guarded live demo fails closed, caps spending and never retries ambiguous sends',async()=>{
 const names=['SMS_DEMO_ENABLED','SMS_MODE','SMS_DEMO_TO','SMS_DEMO_CODE_SHA256','SMS_FARM_MAP_JSON','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER'];
 const old=Object.fromEntries(names.map(k=>[k,process.env[k]])),redis=B.redis;
 const entries=new Map();let attempts=0,budget=0,sends=0;
 B.redis=async c=>{
  if(c[0]==='GET')return entries.get(c[1])||null;
  if(c[0]==='SET'){entries.set(c[1],c[2]);return 'OK'}
  if(c[1]===D.RESERVE){if(entries.has(c[3]))return 0;if(budget>=3)return -1;budget++;entries.set(c[3],c[5]);return 1}
  return ++attempts;
 };
 const identity={farm:'demo',role:'farmer'},id=()=>crypto.randomUUID();
 const send=async(to,message)=>{sends++;assert.equal(to,'+34000000000');assert.equal(message,D.MESSAGE);return{sid:'SM'+'a'.repeat(32),status:'queued'}};
 const request=()=>({action:'demo-send',id:id(),code:'7545',confirm:true});
 try{
  Object.assign(process.env,{SMS_DEMO_ENABLED:'true',SMS_MODE:'live',SMS_DEMO_TO:'+34000000000',SMS_DEMO_CODE_SHA256:crypto.createHash('sha256').update('7545').digest('hex'),SMS_FARM_MAP_JSON:JSON.stringify({'+34000000000':'demo'}),TWILIO_ACCOUNT_SID:'AC-test',TWILIO_AUTH_TOKEN:'test',TWILIO_FROM_NUMBER:'+34000000001'});
  process.env.SMS_DEMO_ENABLED='false';await assert.rejects(D.run(identity,request(),send),/disabled/);process.env.SMS_DEMO_ENABLED='true';
  await assert.rejects(D.run({farm:'other'},request(),send),/recipient/);
  await assert.rejects(D.run(identity,{...request(),code:'wrong'},send),/incorrect/);
  await assert.rejects(D.run(identity,{...request(),confirm:false},send),/consent/);
  assert.equal(sends,0);assert.equal(budget,0);attempts=0;
  const preview=await D.run(identity,{action:'demo-preview'},send);assert.equal(preview.message,D.MESSAGE);assert.equal(sends,0);
  const first=request();const results=await Promise.all([D.run(identity,first,send),D.run(identity,first,send)]);assert.equal(sends,1);assert.equal(budget,1);assert.ok(results.some(x=>x.status==='queued'));
  attempts=0;await D.run(identity,request(),send);
  const ambiguous=request();const result=await D.run(identity,ambiguous,async()=>{sends++;throw Error('response lost')});assert.equal(result.status,'unknown');
  await D.run(identity,ambiguous,send);assert.equal(sends,3);assert.equal(budget,3);
  await assert.rejects(D.run(identity,request(),send),/Daily demo limit/);assert.equal(sends,3);
  attempts=5;await assert.rejects(D.run(identity,request(),send),/15 minutes/);
 }finally{B.redis=redis;for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name]}}
});
test('public unauthenticated endpoint cannot reach live provider',async()=>{
 const res={setHeader(){},end(body){this.body=JSON.parse(body)}};
 await route({method:'POST',headers:{'content-type':'application/json'},body:{action:'demo-send',code:'7545'}},res);
 assert.equal(res.statusCode,401);
});
