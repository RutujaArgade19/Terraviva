'use strict';
const B=require('../lib/backend.cjs');
const MAX_MESSAGE=500;
function providerConfig(){const e=process.env;if(!e.TWILIO_ACCOUNT_SID||!e.TWILIO_AUTH_TOKEN||!e.TWILIO_FROM_NUMBER||!B.e164(e.TWILIO_FROM_NUMBER))throw B.fail(503,'Live SMS provider is not configured.');return e}
async function sendTwilio(to,body){const e=providerConfig();const encoded=new URLSearchParams({To:to,From:e.TWILIO_FROM_NUMBER,Body:body});const auth=Buffer.from(e.TWILIO_ACCOUNT_SID+':'+e.TWILIO_AUTH_TOKEN).toString('base64');const r=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+encodeURIComponent(e.TWILIO_ACCOUNT_SID)+'/Messages.json',{method:'POST',headers:{Authorization:'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},body:encoded,signal:AbortSignal.timeout(8000)});let data={};try{data=await r.json()}catch{}if(!r.ok||!data.sid)throw B.fail(502,'SMS provider rejected the message.');return {provider:'twilio',sid:data.sid,status:data.status||'accepted'} }
module.exports=async(req,res)=>{try{
 if(req.method!=='POST')throw B.fail(405,'Use POST.');
 if(!String(req.headers['content-type']||'').startsWith('application/json'))throw B.fail(415,'Use application/json.');
 const identity=B.auth(req.headers.authorization);if(identity.role!=='farmer')throw B.fail(403,'Farmer access required.');B.config();await B.rate(identity.farm);
 let data=await B.body(req);if(typeof data==='string'){try{data=JSON.parse(data)}catch{throw B.fail(400,'Invalid JSON.')}}
 if(!data||typeof data!=='object')throw B.fail(400,'Invalid request.');
 if(['demo-preview','demo-send','demo-status'].includes(data.action))return B.send(res,200,await require('../lib/sms-demo.cjs').run(identity,data,sendTwilio));
 if(data.action==='consent'){if(typeof data.enabled!=='boolean')throw B.fail(400,'Boolean choice required.');const phone=data.phone||B.enrolledPhone(identity.farm);if(!phone||!B.e164(phone)||phone!==B.enrolledPhone(identity.farm))throw B.fail(400,'Use the enrolled E.164 farmer number.');const result=await B.change(identity.farm,s=>{s.smsConsent=data.enabled?{enabled:true,phone,at:new Date().toISOString()}: {enabled:false,phone,at:new Date().toISOString()};s.events.unshift({time:new Date().toISOString(),text:'Outbound SMS consent '+(data.enabled?'enabled':'disabled')});return {state:s}});return B.send(res,200,{enabled:result.state.smsConsent.enabled,phone:result.state.smsConsent.phone,mode:B.smsMode()})}
 if(data.action!=='send'||typeof data.message!=='string'||data.message.trim().length<1||data.message.length>MAX_MESSAGE)throw B.fail(400,'Message must contain 1 to 500 characters.');
 const state=await B.read(identity.farm),consent=state.smsConsent,phone=B.enrolledPhone(identity.farm);if(!consent?.enabled||!phone||consent.phone!==phone)throw B.fail(403,'Outbound SMS consent is not active.');
 const mode=B.smsMode();if(mode==='demo')return B.send(res,200,{mode:'demo',sent:false,to:phone,detail:'Demo only: no SMS was sent.'});
 throw B.fail(403,'Live sends require the guarded jury-demo flow.');
 }catch(e){B.error(res,e)}};
module.exports.sendTwilio=sendTwilio;
