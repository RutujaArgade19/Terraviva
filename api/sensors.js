'use strict';
const crypto=require('node:crypto'),B=require('../lib/backend.cjs'),Sensors=require('../public/sensor-core.js');
const MAX_REQUEST_BYTES=256*1024;
function registry(){
 let entries;try{entries=JSON.parse(process.env.SENSOR_DEVICE_ACCESS_JSON||'[]')}catch{throw B.fail(503,'Sensor device configuration is invalid.')}
 if(!Array.isArray(entries)||entries.length>1000)throw B.fail(503,'Sensor device configuration is invalid.');
 const hashes=new Set(),devices=new Set();
 for(const entry of entries){
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry.tokenHash!=='string'||!/^[a-f0-9]{64}$/i.test(entry.tokenHash)||
     typeof entry.farm!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(entry.farm)||typeof entry.deviceId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(entry.deviceId)||
     (entry.label!==undefined&&(typeof entry.label!=='string'||!entry.label.trim()||entry.label.length>120||/[\u0000-\u001f\u007f]/.test(entry.label)))||
     (entry.field!==undefined&&(typeof entry.field!=='string'||!entry.field.trim()||entry.field.length>120||/[\u0000-\u001f\u007f]/.test(entry.field)))||
     (entry.enabled!==undefined&&typeof entry.enabled!=='boolean'))throw B.fail(503,'Sensor device configuration is invalid.');
  const hash=entry.tokenHash.toLowerCase(),key=entry.farm+'\0'+entry.deviceId;
  if(hashes.has(hash)||devices.has(key))throw B.fail(503,'Sensor device configuration is ambiguous.');
  hashes.add(hash);devices.add(key);
 }
 let access;try{access=JSON.parse(process.env.DEPOT_ACCESS_JSON||'[]')}catch{throw B.fail(503,'Access configuration is invalid.')}
 if(!Array.isArray(access))throw B.fail(503,'Access configuration is invalid.');
 if(access.some(entry=>typeof entry?.tokenHash==='string'&&hashes.has(entry.tokenHash.toLowerCase())))throw B.fail(503,'Sensor ingest credentials must be separate from farmer and partner credentials.');
 return entries;
}
function deviceAuth(header,entries){
 const match=typeof header==='string'?header.match(/^Bearer (\S{32,1024})$/):null;
 if(!match)throw B.fail(401,'Sensor ingest token required.');
 const hash=crypto.createHash('sha256').update(match[1]).digest();
 const entry=entries.find(item=>crypto.timingSafeEqual(hash,Buffer.from(item.tokenHash,'hex')));
 if(!entry||entry.enabled===false)throw B.fail(401,'Sensor ingest token not recognised.');
 return entry;
}
function publicDevices(entries,farm){return entries.filter(entry=>entry.farm===farm).map(entry=>({deviceId:entry.deviceId,label:entry.label||entry.deviceId,...(entry.field===undefined?{}:{field:entry.field}),enabled:entry.enabled!==false}))}
module.exports=async(req,res)=>{try{
 if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST');throw B.fail(405,'Use GET or POST.')}
 if(req.method==='GET'){
  const identity=B.auth(req.headers.authorization);
  if(identity.role!=='farmer')throw B.fail(403,'Farmer access is required to read sensor data.');
  B.config();await B.rate(identity.farm);
  const entries=registry(),state=await B.read(identity.farm),snapshot=Sensors.snapshot(state.sensors);
  return B.send(res,200,{farm:identity.farm,devices:publicDevices(entries,identity.farm),readings:snapshot.readings,capacity:Sensors.MAX_READINGS,remaining:Sensors.MAX_READINGS-snapshot.readings.length,stateBytes:B.stateBytes(state),maxStateBytes:B.MAX_DEPOT_BYTES,role:'private-sensor-data',commercialUse:'not-enabled-by-this-module'});
 }
 if(!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type']||'')))throw B.fail(415,'Use application/json.');
 const entries=registry(),device=deviceAuth(req.headers.authorization,entries);
 B.config();await B.rate(device.farm);
 let data=await B.body(req,MAX_REQUEST_BYTES);
 if(typeof data==='string'){try{data=JSON.parse(data)}catch{throw B.fail(400,'Invalid JSON.')}}
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>key!=='readings'))throw B.fail(400,'Supply only a readings array. Farm identity comes from the ingest credential.');
 const now=Date.now(),options={deviceId:device.deviceId,...(device.field===undefined?{}:{field:device.field}),now};
 const plan=Sensors.prepare(data.readings,options);
 if(plan.issues.length)throw Object.assign(B.fail(400,'Sensor readings failed validation.'),{issues:plan.issues});
 const result=await B.change(device.farm,state=>Sensors.commit(state,plan,options));
 return B.send(res,result.accepted?201:200,{farm:device.farm,deviceId:device.deviceId,accepted:result.accepted,duplicates:result.duplicates,totalReadings:result.totalReadings,capacity:result.capacity,readings:result.readings});
}catch(error){B.error(res,error)}};
module.exports.registry=registry;
module.exports.deviceAuth=deviceAuth;
module.exports.MAX_REQUEST_BYTES=MAX_REQUEST_BYTES;
