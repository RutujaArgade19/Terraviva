const B=require('../lib/backend.cjs'),Core=require('../public/core.js');
const xml=t=>String(t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
module.exports=async(req,res)=>{try{
if(req.method!=='POST')throw B.fail(405,'Use POST.');
const e=process.env;if(!e.TWILIO_AUTH_TOKEN||!e.TWILIO_WEBHOOK_URL||!e.SMS_FARM_MAP_JSON)throw B.fail(503,'Live SMS is not configured.');
if(!String(req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'))throw B.fail(415,'Use form encoding.');
let params=await B.body(req);if(typeof params==='string'){const form=new URLSearchParams(params);if(new Set(form.keys()).size!==[...form.keys()].length)throw B.fail(400,'Duplicate parameters unsupported.');params=Object.fromEntries(form)}
if(!params||Object.values(params).some(v=>typeof v!=='string'))throw B.fail(400,'Invalid form parameters.');
if(!B.validSignature(req.headers['x-twilio-signature'],B.signature(e.TWILIO_AUTH_TOKEN,e.TWILIO_WEBHOOK_URL,params)))throw B.fail(403,'Invalid SMS signature.');
const mapping=JSON.parse(e.SMS_FARM_MAP_JSON);const farm=Object.hasOwn(mapping,params.From)?mapping[params.From]:null;if(!farm)throw B.fail(403,'Phone is not enrolled.');
if(!/^SM[a-fA-F0-9]{32}$/.test(params.MessageSid||'')||typeof params.Body!=='string'||params.Body.length>500)throw B.fail(400,'Invalid SMS.');
await B.rate(farm);const result=await B.change(farm,s=>Core.apply(s,params.Body,params.MessageSid));
B.send(res,200,'<?xml version="1.0" encoding="UTF-8"?><Response>'+(result.duplicate?'':'<Message>'+xml(result.reply)+'</Message>')+'</Response>','text/xml');
}catch(e){B.error(res,e)}};
module.exports.xml=xml;
