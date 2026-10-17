'use strict';
const crypto=require('node:crypto'),Core=require('../public/core.js');
const MAX_DEPOT_BYTES=3*1024*1024;
const fail=(code,message)=>Object.assign(new Error(message),{status:code});
function stateBytes(state){return Buffer.byteLength(JSON.stringify(state),'utf8')}
function config(){const e=process.env;
if(!e.UPSTASH_REDIS_REST_URL||!e.UPSTASH_REDIS_REST_TOKEN||!/^[a-f0-9]{64}$/i.test(e.DEPOT_ENCRYPTION_KEY||''))throw fail(503,'Private depot is not configured.');
return e}
function encrypt(value,key,aad){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);c.setAAD(Buffer.from(aad));const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return JSON.stringify({iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')})}
function decrypt(raw,key,aad){const p=JSON.parse(raw),d=crypto.createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(p.iv,'base64'));d.setAAD(Buffer.from(aad));d.setAuthTag(Buffer.from(p.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(p.data,'base64')),d.final()]).toString())}
async function redis(command){const e=config();const r=await fetch(e.UPSTASH_REDIS_REST_URL,{method:'POST',headers:{Authorization:'Bearer '+e.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(8000)});if(!r.ok)throw fail(503,'Depot storage unavailable.');const x=await r.json();if(x.error)throw fail(503,'Depot storage request failed.');return x.result}
function keyFor(farm){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(farm||''))throw fail(403,'Invalid farm identity.');return 'terraviva:v2:'+farm}
async function read(farm){const key=keyFor(farm),e=config(),raw=await redis(['GET',key]);return raw?decrypt(raw,e.DEPOT_ENCRYPTION_KEY,key):Core.initial()}
async function change(farm,fn){const key=keyFor(farm),e=config();for(let tries=0;tries<5;tries++){const raw=await redis(['GET',key]),state=raw?decrypt(raw,e.DEPOT_ENCRYPTION_KEY,key):Core.initial();const result=fn(state);if(stateBytes(result.state)>MAX_DEPOT_BYTES)throw fail(507,'Private depot pilot storage is full (3 MiB). No data was saved or removed. Export and plan additional storage before continuing.');const next=encrypt(result.state,e.DEPOT_ENCRYPTION_KEY,key);
const success=await redis(['EVAL',"local current=redis.call('GET',KEYS[1]); if (not current and ARGV[1]=='') or current==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]); return 1 else return 0 end",1,key,raw||'',next]);if(success===1)return result}throw fail(409,'Concurrent update. Please retry.')}
function auth(header){const token=String(header||'').replace(/^Bearer /,'');if(token.length<32)throw fail(401,'Access token required.');let entries;try{entries=JSON.parse(process.env.DEPOT_ACCESS_JSON||'[]')}catch{throw fail(503,'Access configuration invalid.')}
const hash=crypto.createHash('sha256').update(token).digest('hex');const found=entries.find(x=>typeof x.tokenHash==='string'&&x.tokenHash.length===64&&crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(x.tokenHash)));if(!found)throw fail(401,'Access token not recognised.');keyFor(found.farm);return found}
async function rate(farm){const k='terraviva:rate:'+farm+':'+Math.floor(Date.now()/60000);const n=await redis(['EVAL',"local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],120) end; return n",1,k]);if(n>60)throw fail(429,'Too many requests. Try again in a minute.')}
function decodeUTF8(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw fail(400,'Request must use valid UTF-8 text.')}}
async function body(req,maximumBytes=16384){if(req.body!==undefined){if(Buffer.isBuffer(req.body)){if(req.body.byteLength>maximumBytes)throw fail(413,'Request too large.');return decodeUTF8(req.body)}const data=req.body,serialized=typeof data==='string'?data:JSON.stringify(data);if(Buffer.byteLength(serialized||'','utf8')>maximumBytes)throw fail(413,'Request too large.');return data}
const chunks=[];let bytes=0;for await(const chunk of req){const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=data.byteLength;if(bytes>maximumBytes)throw fail(413,'Request too large.');chunks.push(data)}return decodeUTF8(Buffer.concat(chunks,bytes))}
function send(res,code,data,type='application/json'){res.statusCode=code;res.setHeader('Content-Type',type);res.setHeader('Cache-Control','no-store');res.end(type==='application/json'?JSON.stringify(data):data)}
function error(res,e){const data={error:e.status?e.message:'Service temporarily unavailable.'};if(e.status===400&&Array.isArray(e.issues)){data.issues=e.issues.slice(0,30);data.issueCount=e.issues.length}send(res,e.status||503,data)}
function signature(token,url,params){return crypto.createHmac('sha1',token).update(url+Object.keys(params).sort().map(k=>k+params[k]).join('')).digest('base64')}
function validSignature(value,expected){const a=Buffer.from(value||''),b=Buffer.from(expected);return a.length===b.length&&crypto.timingSafeEqual(a,b)}
module.exports={MAX_DEPOT_BYTES,stateBytes,fail,config,encrypt,decrypt,redis,read,change,auth,rate,body,send,error,signature,validSignature};

