'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const S=require('../public/sensor-core.js'),C=require('../public/core.js'),B=require('../lib/backend.cjs'),api=require('../api/sensors.js'),depot=require('../api/depot.js');
const NOW=Date.UTC(2026,9,17,12,0,0);
const reading=(overrides={})=>({id:'reading-001',deviceId:'probe-north',field:'North Field',observedAt:'2000-01-01T10:00:00Z',measurement:'soil_moisture',value:'23.500',unit:'%',quality:'unverified',...overrides});
const plan=(rows,options={})=>S.prepare(rows,{now:NOW,...options});

test('sensor model retains lexical values and units, server receipt time and private state',()=>{
 const before={...C.initial(),records:[{id:'harvest',volume:1}],commercial:true,grants:[{recipient:'COOP',fields:['volume'],expires:'2099-01-01',revoked:false}]};
 const copy=structuredClone(before),result=S.commit(before,plan([reading()]),{now:NOW});
 assert.deepEqual(before,copy);assert.deepEqual(result.state.grants,before.grants);assert.equal(result.state.commercial,true);assert.deepEqual(result.state.records,before.records);
 assert.equal(result.state.sensors.readings[0].value,'23.500');assert.equal(result.state.sensors.readings[0].unit,'%');assert.equal(result.state.sensors.readings[0].receivedAt,new Date(NOW).toISOString());
 assert.equal(C.project(result.state,'COOP',NOW)[0].sensorReadings,undefined);
});

test('exact retries are idempotent and keep the original received time',()=>{
 const first=S.merge(S.initial(),plan([reading(),reading()]),{now:NOW});
 assert.equal(first.accepted,1);assert.equal(first.duplicates,1);
 const retry=S.merge(first.state,plan([reading()]),{now:NOW+60000});
 assert.equal(retry.accepted,0);assert.equal(retry.duplicates,1);assert.equal(retry.totalReadings,1);
 assert.equal(retry.readings[0].receivedAt,first.readings[0].receivedAt);
});

test('changed IDs conflict atomically, including conflicts inside one batch',()=>{
 const first=S.merge(S.initial(),plan([reading()]),{now:NOW}),before=structuredClone(first.state);
 assert.throws(()=>S.merge(first.state,plan([reading({id:'new-id'}),reading({value:'25'})]),{now:NOW}),error=>error.status===409);
 assert.deepEqual(first.state,before);
 assert.throws(()=>S.merge(S.initial(),plan([reading(),reading({quality:'ok'})]),{now:NOW}),error=>error.status===409);
});

test('delayed and out-of-order readings are accepted with explicit timezone validation',()=>{
 const result=S.merge(S.initial(),plan([reading({id:'later',observedAt:'2026-10-17T12:00:00+02:00'}),reading({id:'old',observedAt:'1999-12-31T23:00:00Z'})]),{now:NOW});
 assert.equal(result.accepted,2);assert.equal(result.state.readings[0].observedAt,'2026-10-17T12:00:00+02:00');
 for(const value of ['2026-02-30T00:00:00Z','2025-02-29T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T12:00:00','2026-01-01T12:00:00+15:00','not-a-date'])assert.equal(S.validTimestamp(value),false,value);
 assert.ok(plan([reading({observedAt:new Date(NOW+S.MAX_FUTURE_MS+1).toISOString()})]).issues.some(issue=>issue.field==='observedAt'));
});

test('units, quality, numeric values and credential binding are validated without conversions',()=>{
 for(const patch of [{unit:'m3/m3'},{measurement:'unknown'},{quality:'approved-by-farmer'},{value:Infinity},{value:'NaN'},{value:''},{value:'1e309'},{receivedAt:'2000-01-01T00:00:00Z'},{farm:'another-farm'}])assert.ok(plan([reading(patch)]).issues.length,JSON.stringify(patch));
 assert.ok(plan([reading()],{deviceId:'another-device'}).issues.length);
 assert.ok(plan([reading()],{field:'Another Field'}).issues.length);
 assert.equal(plan([reading({value:23.5,quality:undefined})]).readings[0].value,'23.5');
 assert.equal(plan([reading({value:'00023.500'})]).readings[0].value,'00023.500');
 assert.throws(()=>S.merge(S.initial(),{readings:[reading({unit:'wrong'})],issues:[]},{now:NOW}),error=>error.status===400);
});

test('capacity rejects a whole batch without dropping old readings; retries remain accepted',()=>{
 const state={version:1,readings:Array.from({length:S.MAX_READINGS},(_,index)=>({...reading({id:'r-'+index}),receivedAt:new Date(NOW).toISOString()}))};
 const copy=structuredClone(state);
 assert.throws(()=>S.merge(state,plan([reading({id:'one-too-many'})]),{now:NOW}),error=>error.status===507);
 assert.deepEqual(state,copy);
 const retry=S.merge(state,plan([reading({id:'r-0'})]),{now:NOW+1});assert.equal(retry.accepted,0);assert.equal(retry.duplicates,1);
 assert.ok(S.prepare(Array.from({length:S.MAX_BATCH+1},()=>reading()),{now:NOW}).issues.length);
});

async function invoke(handler,method,body,token,extra={}){const result={headers:{}};await handler({method,body,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...extra}},{setHeader(k,v){result.headers[k]=v},set statusCode(value){result.status=value},end(value){result.body=JSON.parse(value)}});return result}
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
async function environment(run){
 const names=['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','DEPOT_ENCRYPTION_KEY','DEPOT_ACCESS_JSON','SENSOR_DEVICE_ACCESS_JSON'];
 const old=Object.fromEntries(names.map(name=>[name,process.env[name]])),fetch=global.fetch;
 const tokens={farmer:'synthetic-farmer-credential-000000000000001',farmerB:'synthetic-farmer-credential-000000000000002',partner:'synthetic-partner-credential-0000000000001',device:'synthetic-ingest-credential-00000000000001',deviceB:'synthetic-ingest-credential-00000000000002'};
 const entries=[{tokenHash:sha(tokens.device),farm:'farm-a',deviceId:'probe-north',field:'North Field',label:'Synthetic test probe'},{tokenHash:sha(tokens.deviceB),farm:'farm-b',deviceId:'probe-south',field:'South Field'}];
 Object.assign(process.env,{UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'synthetic',DEPOT_ENCRYPTION_KEY:'ab'.repeat(32),
  DEPOT_ACCESS_JSON:JSON.stringify([{tokenHash:sha(tokens.farmer),farm:'farm-a',role:'farmer'},{tokenHash:sha(tokens.farmerB),farm:'farm-b',role:'farmer'},{tokenHash:sha(tokens.partner),farm:'farm-a',role:'partner',recipient:'COOP'}]),SENSOR_DEVICE_ACCESS_JSON:JSON.stringify(entries)});
 const db=new Map();global.fetch=async(url,options)=>{const command=JSON.parse(options.body);let result;
  if(command[0]==='GET')result=db.get(command[1])||null;
  else if(command[1].includes('INCR'))result=1;
  else{const current=db.get(command[3])||'';result=current===command[4]?1:0;if(result)db.set(command[3],command[5])}
  return {ok:true,json:async()=>({result})};};
 try{return await run({tokens,entries,db})}finally{global.fetch=fetch;for(const name of names)if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name]}
}

test('sensor API denies unauthenticated callers, role crossover, and partner reads',()=>environment(async({tokens})=>{
 assert.equal((await invoke(api,'GET')).status,401);
 assert.equal((await invoke(api,'POST',{readings:[reading()]})).status,401);
 assert.equal((await invoke(api,'GET',undefined,tokens.device)).status,401);
 assert.equal((await invoke(api,'GET',undefined,tokens.partner)).status,403);
 assert.equal((await invoke(api,'POST',{readings:[reading()]},tokens.farmer)).status,401);
 assert.equal((await invoke(api,'POST',{readings:[reading()]},tokens.partner)).status,401);
}));

test('sensor API encrypts readings, enforces farm/device isolation, and exposes no token hashes',()=>environment(async({tokens,db})=>{
 const saved=await invoke(api,'POST',{readings:[reading()]},tokens.device);assert.equal(saved.status,201);assert.equal(saved.body.farm,'farm-a');assert.equal(saved.body.accepted,1);
 const read=await invoke(api,'GET',undefined,tokens.farmer);assert.equal(read.status,200);assert.equal(read.body.readings.length,1);assert.equal(read.body.readings[0].value,'23.500');assert.equal(read.body.devices.length,1);assert.equal(read.body.devices[0].tokenHash,undefined);
 const other=await invoke(api,'GET',undefined,tokens.farmerB);assert.equal(other.body.readings.length,0);assert.equal(other.body.devices[0].deviceId,'probe-south');
 assert.equal((await invoke(api,'POST',{farm:'farm-b',readings:[reading()]},tokens.device)).status,400);
 assert.equal((await invoke(api,'POST',{readings:[reading({deviceId:'probe-south'})]},tokens.device)).status,400);
 assert.equal((await invoke(api,'POST',{readings:[reading({field:'South Field'})]},tokens.device)).status,400);
 assert.equal([...db.values()].some(value=>value.includes('North Field')||value.includes('soil_moisture')),false);
 assert.equal(read.headers['Cache-Control'],'no-store');
}));

test('sensor API replay is idempotent and rejects conflicting IDs without partial writes',()=>environment(async({tokens,db})=>{
 const first=await invoke(api,'POST',{readings:[reading()]},tokens.device);const received=first.body.readings[0].receivedAt;
 const retry=await invoke(api,'POST',{readings:[reading()]},tokens.device);assert.equal(retry.status,200);assert.equal(retry.body.duplicates,1);assert.equal(retry.body.readings[0].receivedAt,received);
 const before=db.get('terraviva:v2:farm-a');
 const conflict=await invoke(api,'POST',{readings:[reading({id:'new-one'}),reading({value:'24.0'})]},tokens.device);
 assert.equal(conflict.status,409);assert.equal(db.get('terraviva:v2:farm-a'),before);
 assert.equal((await invoke(api,'GET',undefined,tokens.farmer)).body.readings.length,1);
}));

test('sensor ingestion does not alter farmer grants, commercial choices, or harvest projection',()=>environment(async({tokens})=>{
 const state={...C.initial(),commercial:true,records:[{product:'wheat',volume:5,date:'2000-01-01',field:'North Field'}],grants:[{recipient:'COOP',fields:['product','volume'],expires:'2099-01-01T00:00:00Z',revoked:false}]};
 await B.change('farm-a',()=>({state}));
 assert.equal((await invoke(api,'POST',{readings:[reading()]},tokens.device)).status,201);
 const after=await B.read('farm-a');assert.equal(after.commercial,true);assert.deepEqual(after.grants,state.grants);assert.deepEqual(after.records,state.records);
 const partner=await invoke(depot,'POST',{action:'read'},tokens.partner);assert.equal(partner.status,200);assert.deepEqual(partner.body.records,[{product:'wheat',volume:5}]);assert.equal(partner.body.sensors,undefined);
 assert.equal((await invoke(api,'GET',undefined,tokens.partner)).status,403);
}));

test('sensor API rejects malformed and oversized requests without saving records',()=>environment(async({tokens,db})=>{
 for(const body of ['{',null,[],{readings:[]},{readings:[reading({observedAt:'2026-02-30T00:00:00Z'})]},{readings:[reading({unit:'fraction'})]},{readings:[reading({commercial:true})]}])assert.equal((await invoke(api,'POST',body,tokens.device)).status,400);
 assert.equal((await invoke(api,'POST','x'.repeat(api.MAX_REQUEST_BYTES+1),tokens.device)).status,413);
 assert.equal((await invoke(api,'POST',{readings:[reading()]},tokens.device,{'content-type':'text/plain'})).status,415);
 assert.equal((await invoke(api,'DELETE',undefined,tokens.farmer)).status,405);
 assert.equal(db.has('terraviva:v2:farm-a'),false);
}));

test('disabled, duplicate, mistyped and reused credentials fail closed',()=>environment(async({tokens,entries})=>{
 process.env.SENSOR_DEVICE_ACCESS_JSON=JSON.stringify([{...entries[0],enabled:false}]);assert.equal((await invoke(api,'POST',{readings:[reading()]},tokens.device)).status,401);
 for(const invalid of [[entries[0],entries[0]],[{...entries[0],farm:123}],[{...entries[0],deviceId:456}],[{...entries[0],tokenHash:sha(tokens.farmer)}]]){
  process.env.SENSOR_DEVICE_ACCESS_JSON=JSON.stringify(invalid);assert.equal((await invoke(api,'POST',{readings:[reading()]},tokens.device)).status,503);
 }
}));

test('unconfigured private storage never falls back to in-memory sensor persistence',()=>environment(async({tokens})=>{
 delete process.env.UPSTASH_REDIS_REST_TOKEN;
 assert.equal((await invoke(api,'POST',{readings:[reading()]},tokens.device)).status,503);
 assert.equal((await invoke(api,'GET',undefined,tokens.farmer)).status,503);
}));

test('whole-depot byte bound includes UTF-8 bytes and refuses overflow before storage changes',()=>environment(async({db})=>{
 const empty=C.initial(),fixed=B.stateBytes({...empty,padding:''}),padding='x'.repeat(B.MAX_DEPOT_BYTES-fixed);
 const exact={...empty,padding};assert.equal(B.stateBytes(exact),B.MAX_DEPOT_BYTES);
 await B.change('farm-a',()=>({state:exact}));const encrypted=db.get('terraviva:v2:farm-a');
 await assert.rejects(()=>B.change('farm-a',state=>({state:{...state,padding:state.padding+'é'}})),error=>error.status===507);
 assert.equal(db.get('terraviva:v2:farm-a'),encrypted);assert.equal((await B.read('farm-a')).padding.length,padding.length);
 assert.equal(B.stateBytes({text:'é'})-B.stateBytes({text:''}),2);
}));

test('sensor byte-cap failure is atomic and leaves count, grants and consent intact',()=>environment(async({tokens,db})=>{
 const existing={...C.initial(),commercial:true,grants:[{recipient:'COOP'}]},fixed=B.stateBytes({...existing,padding:''});
 await B.change('farm-a',()=>({state:{...existing,padding:'x'.repeat(B.MAX_DEPOT_BYTES-fixed-50)}}));
 const encrypted=db.get('terraviva:v2:farm-a');
 const result=await invoke(api,'POST',{readings:[reading()]},tokens.device);assert.equal(result.status,507);assert.equal(db.get('terraviva:v2:farm-a'),encrypted);
 const after=await B.read('farm-a');assert.equal(after.commercial,true);assert.deepEqual(after.grants,existing.grants);assert.equal(after.sensors,undefined);
}));
