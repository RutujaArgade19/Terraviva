'use strict';
const crypto=require('node:crypto'),B=require('./backend.cjs');
const MESSAGE='Terraviva jury demo: Ana has 3 illustrative harvest records, 24.30 tonnes. One farmer-controlled wallet. This is a demonstration, not a real farm report.';
const RESERVE="if redis.call('EXISTS',KEYS[1])==1 then return 0 end; local n=tonumber(redis.call('GET',KEYS[2]) or '0'); if n>=3 then return -1 end; redis.call('SET',KEYS[1],ARGV[1],'EX',604800); redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],172800); return 1";
function enabled(){return process.env.SMS_DEMO_ENABLED==='true'&&B.smsMode()==='live'}
function recipient(farm){const phone=process.env.SMS_DEMO_TO;if(!B.e164(phone)||phone!==B.enrolledPhone(farm))throw B.fail(503,'Approved demo recipient is not configured for this farmer.');return phone}
function key(farm,id){if(typeof id!=='string'||! /^[a-f0-9-]{36}$/i.test(id))throw B.fail(400,'A valid request ID is required.');return 'terraviva:sms-demo:'+farm+':'+id}
async function run(identity,data,sendTwilio){
 const farm=identity.farm;
 if(data.action==='demo-preview'){
  if(!enabled())throw B.fail(503,'Live jury demo is disabled. Ask the presenter to configure Vercel.');
  const phone=recipient(farm);
  return {message:MESSAGE,to:phone,limit:3,mode:'live'};
 }
 if(data.action==='demo-status'){
  const raw=await B.redis(['GET',key(farm,data.id)]);if(!raw)throw B.fail(404,'No send attempt found.');
  const receipt=JSON.parse(raw);
  if(receipt.messageSid){
   const e=process.env,auth=Buffer.from(e.TWILIO_ACCOUNT_SID+':'+e.TWILIO_AUTH_TOKEN).toString('base64');
   const r=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+encodeURIComponent(e.TWILIO_ACCOUNT_SID)+'/Messages/'+encodeURIComponent(receipt.messageSid)+'.json',{headers:{Authorization:'Basic '+auth},signal:AbortSignal.timeout(8000)});
   if(!r.ok)throw B.fail(502,'Delivery status temporarily unavailable. Do not resend.');
   const result=await r.json();return {...receipt,status:result.status,errorCode:result.error_code||null};
  }
  return receipt;
 }
 if(!enabled())throw B.fail(503,'Live jury demo is disabled.');
 const phone=recipient(farm),requestKey=key(farm,data.id);
 const attempts=await B.redis(['EVAL',"local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n",1,'terraviva:sms-code:'+farm+':'+Math.floor(Date.now()/900000)]);
 if(attempts>5)throw B.fail(429,'Too many confirmation attempts. Wait 15 minutes.');
 const hash=process.env.SMS_DEMO_CODE_SHA256;
 if(!/^[a-f0-9]{64}$/i.test(hash||''))throw B.fail(503,'Presenter confirmation is not configured.');
 const supplied=crypto.createHash('sha256').update(typeof data.code==='string'?data.code:'').digest();
 if(!crypto.timingSafeEqual(supplied,Buffer.from(hash,'hex')))throw B.fail(403,'Confirmation code is incorrect.');
 if(data.confirm!==true)throw B.fail(400,'Explicit recipient consent and charge confirmation are required.');
 if(!process.env.TWILIO_ACCOUNT_SID||!process.env.TWILIO_AUTH_TOKEN||!B.e164(process.env.TWILIO_FROM_NUMBER))throw B.fail(503,'Twilio sender is not configured.');
 const prior=await B.redis(['GET',requestKey]);if(prior)return JSON.parse(prior);
 const receipt={status:'unknown',detail:'Attempt reserved. Do not resend if the provider response is lost.'};
 const reserved=await B.redis(['EVAL',RESERVE,2,requestKey,'terraviva:sms-demo-budget:'+new Date().toISOString().slice(0,10),JSON.stringify(receipt)]);
 if(reserved===-1)throw B.fail(429,'Daily demo limit reached (3 attempts across all presenters).');
 if(reserved!==1)return JSON.parse(await B.redis(['GET',requestKey]));
 // Consent is explicit for this single, fixed demonstration message. No reusable opt-in is created.
 try{const result=await sendTwilio(phone,MESSAGE);Object.assign(receipt,{messageSid:result.sid,status:result.status,detail:'Provider accepted the message. Acceptance is not delivery.'})}
 catch{receipt.detail='Provider outcome unknown or rejected. Attempt remains consumed. Check Twilio before trying another message.'}
 await B.redis(['SET',requestKey,JSON.stringify(receipt),'EX',604800]);return receipt;
}
module.exports={MESSAGE,RESERVE,run};
