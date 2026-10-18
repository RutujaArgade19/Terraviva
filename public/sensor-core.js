(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SensorCore=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION=1,MAX_BATCH=500,MAX_READINGS=10000,MAX_FUTURE_MS=5*60*1000;
const MEASUREMENTS=Object.freeze({air_temperature:'°C',soil_temperature:'°C',soil_moisture:'%',relative_humidity:'%',rainfall:'mm',soil_ph:'pH',electrical_conductivity:'dS/m',battery_voltage:'V',wind_speed:'m/s',solar_radiation:'W/m²'});
const QUALITY=Object.freeze(['unverified','ok','suspect','invalid']);
const FIELDS=Object.freeze(['id','deviceId','field','observedAt','measurement','value','unit','quality']);
const identifier=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,deviceIdentifier=/^[A-Za-z0-9_-]{1,80}$/;
const numeric=/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function fail(status,message,issues){return Object.assign(new Error(message),{status,...(issues?{issues}:{})})}
function initial(){return {version:VERSION,readings:[]}}
function validTimestamp(value){
 if(typeof value!=='string')return false;
 const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
 if(!m)return false;
 const y=Number(m[1]),month=Number(m[2]),day=Number(m[3]),hour=Number(m[4]),minute=Number(m[5]),second=Number(m[6]);
 const leap=y%4===0&&(y%100!==0||y%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)return false;
 if(m[8]!=='Z'&&(Number(m[10])>14||Number(m[11])>59||(Number(m[10])===14&&Number(m[11])!==0)))return false;
 return Number.isFinite(Date.parse(value));
}
function prepare(input,options={}){
 const now=options.now===undefined?Date.now():options.now,issues=[],readings=[];
 if(!Number.isFinite(now))throw fail(400,'A valid receiver time is required.');
 if(!Array.isArray(input)||input.length<1||input.length>MAX_BATCH)return {readings:[],issues:[{index:0,field:'readings',message:'Supply between 1 and '+MAX_BATCH+' readings.'}]};
 const issue=(index,field,message)=>issues.push({index:index+1,field,message});
 input.forEach((row,index)=>{
  if(!row||typeof row!=='object'||Array.isArray(row)){issue(index,'reading','Each reading must be an object.');return}
  for(const key of Object.keys(row))if(!FIELDS.includes(key))issue(index,key,'Unsupported field. Farm, consent and receiver time come from the server.');
  if(typeof row.id!=='string'||!identifier.test(row.id))issue(index,'id','Use a stable reading ID of 1–128 letters, digits, dots, colons, underscores or hyphens.');
  if(typeof row.deviceId!=='string'||!deviceIdentifier.test(row.deviceId))issue(index,'deviceId','A registered device ID is required.');
  if(options.deviceId!==undefined&&row.deviceId!==options.deviceId)issue(index,'deviceId','This credential cannot submit readings for that device.');
  if(typeof row.field!=='string'||!row.field.trim()||row.field.length>120||/[\u0000-\u001f\u007f]/.test(row.field))issue(index,'field','Supply a nonblank field name of at most 120 characters, without control characters.');
  if(options.field!==undefined&&row.field!==options.field)issue(index,'field','This device is enrolled for a different field.');
  if(!validTimestamp(row.observedAt))issue(index,'observedAt','Use a valid ISO timestamp with seconds and an explicit timezone.');
  else if(Date.parse(row.observedAt)>now+MAX_FUTURE_MS)issue(index,'observedAt','Observation time cannot be more than five minutes ahead of the receiver.');
  if(typeof row.measurement!=='string'||!Object.hasOwn(MEASUREMENTS,row.measurement))issue(index,'measurement','This measurement is not supported by the pilot.');
  else if(row.unit!==MEASUREMENTS[row.measurement])issue(index,'unit','Expected '+MEASUREMENTS[row.measurement]+' for '+row.measurement+'. Units are never converted.');
  const value=typeof row.value==='number'&&Number.isFinite(row.value)?String(row.value):row.value;
  if(typeof value!=='string'||value.length>80||!numeric.test(value)||!Number.isFinite(Number(value)))issue(index,'value','Supply a finite numeric value or numeric text of at most 80 characters.');
  const quality=row.quality===undefined?'unverified':row.quality;
  if(!QUALITY.includes(quality))issue(index,'quality','Use unverified, ok, suspect or invalid.');
  readings.push({id:row.id,deviceId:row.deviceId,field:row.field,observedAt:row.observedAt,measurement:row.measurement,value,unit:row.unit,quality});
 });
 return {readings,issues};
}
function identity(reading){return reading.deviceId+'\u0000'+reading.id}
function same(a,b){return FIELDS.every(field=>a[field]===b[field])}
function snapshot(value){
 if(value===undefined)return initial();
 if(!value||value.version!==VERSION||!Array.isArray(value.readings)||value.readings.length>MAX_READINGS)throw fail(503,'Stored sensor data requires a compatible migration.');
 return value;
}
function merge(sensorState,prepared,options={}){
 const now=options.now===undefined?Date.now():options.now;
 if(!prepared||!Array.isArray(prepared.issues)||prepared.issues.length||!Array.isArray(prepared.readings))throw fail(400,'Sensor readings failed validation.',prepared?.issues||[]);
 // Revalidate normalized rows so callers cannot bypass validation with a forged plan.
 const checked=prepare(prepared.readings,{...options,now});
 if(checked.issues.length)throw fail(400,'Sensor readings failed validation.',checked.issues);
 const current=snapshot(sensorState),state=structuredClone(current),seen=new Map();
 for(const reading of state.readings){if(!reading||!validTimestamp(reading.receivedAt)||seen.has(identity(reading)))throw fail(503,'Stored sensor data requires a compatible migration.');seen.set(identity(reading),reading)}
 const acceptedRows=[],responseRows=[];let duplicates=0;
 for(const reading of checked.readings){
  const key=identity(reading),existing=seen.get(key);
  if(existing){if(!same(existing,reading))throw fail(409,'Reading ID conflicts with an existing reading for this device.');duplicates++;responseRows.push(existing);continue}
  if(state.readings.length>=MAX_READINGS)throw fail(507,'Sensor pilot storage is full. No readings were saved or removed. Export and plan additional storage before continuing.');
  const stored={...reading,receivedAt:new Date(now).toISOString()};state.readings.push(stored);seen.set(key,stored);acceptedRows.push(stored);responseRows.push(stored);
 }
 return {state,accepted:acceptedRows.length,duplicates,totalReadings:state.readings.length,capacity:MAX_READINGS,readings:responseRows};
}
function commit(depotState,prepared,options={}){
 if(!depotState||typeof depotState!=='object'||Array.isArray(depotState))throw fail(503,'Stored depot data is invalid.');
 const result=merge(depotState.sensors,prepared,options);
 return {...result,state:{...structuredClone(depotState),sensors:result.state}};
}
return {VERSION,MAX_BATCH,MAX_READINGS,MAX_FUTURE_MS,MEASUREMENTS,QUALITY,FIELDS,initial,prepare,validateBatch:prepare,validTimestamp,snapshot,merge,commit};
});
