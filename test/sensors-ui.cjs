'use strict';
// Synthetic fixtures exercise the sensor UI model. They are never bundled as farm readings.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const Core=require('../public/sensor-core.js'),EDA=require('../public/eda-engine.js'),UI=require('../public/sensors.js');
const NOW=Date.parse('2026-10-17T12:00:00Z');
const reading=(overrides={})=>({id:'reading-001',deviceId:'sensor-north',field:'North field',observedAt:'2026-10-17T10:00:00Z',measurement:'soil_temperature',value:'018.00',unit:'°C',quality:'unverified',...overrides});
const stored=(overrides={})=>({...reading(overrides),receivedAt:'2026-10-17T12:00:00Z'});
const snapshot=(overrides={})=>({farm:'farm-a',role:'private-sensor-data',commercialUse:'not-enabled-by-this-module',devices:[{deviceId:'sensor-north',label:'North soil sensor',enabled:true}],readings:[stored()],capacity:10000,remaining:9999,...overrides});
const response=data=>({ok:true,json:async()=>structuredClone(data)});
const token='synthetic-farmer-token-never-persisted-0123456789';

test('sensor workspace starts empty and performs no network call for local demo ingestion',()=>{
  let calls=0;const session=UI.createSession({core:Core,now:()=>NOW,fetch:()=>{calls++;throw Error('Unexpected network call')}});
  assert.equal(session.state.mode,'demo');assert.equal(session.state.farm,null);assert.deepEqual(session.state.readings,[]);
  assert.equal(session.addDemo([reading()]),true);assert.equal(session.state.readings.length,1);assert.equal(session.state.readings[0].value,'018.00');assert.equal(session.state.readings[0].receivedAt,'2026-10-17T12:00:00.000Z');assert.equal(calls,0);
});

test('demo import is atomic and shares gateway duplicate/conflict validation',()=>{
  const session=UI.createSession({core:Core,now:()=>NOW});assert.equal(session.addDemo([reading()]),true);
  assert.equal(session.addDemo([reading()]),true);assert.equal(session.state.readings.length,1);assert.match(session.state.message,/1 exact repeat/);
  assert.equal(session.addDemo([reading({id:'new'}),reading({value:'19'})]),false);assert.equal(session.state.readings.length,1);assert.match(session.state.error,/conflicts/);
  assert.equal(session.addDemo([reading({id:'new'}),reading({id:'bad-unit',unit:'F'})]),false);assert.equal(session.state.readings.length,1);assert.ok(session.state.issues.some(issue=>issue.field==='unit'));
  assert.equal(session.addDemo([reading({id:'wrong-farm',farm:'another-farm'})]),false);assert.equal(session.state.readings.length,1);
});

test('CSV and JSON import retain source text and reject ambiguous or authority-bearing formats',()=>{
  const csv='id,deviceId,field,observedAt,measurement,value,unit,quality\n9007199254740993,sensor-north,Peña,2026-10-17T10:00:00Z,soil_temperature,018.00,°C,suspect\n';
  const rows=UI.parseBatch(csv,'sensors.csv',EDA);assert.equal(rows[0].id,'9007199254740993');assert.equal(rows[0].value,'018.00');assert.equal(rows[0].field,'Peña');assert.equal(Core.prepare(rows,{now:NOW}).issues.length,0);
  const json=UI.parseBatch(JSON.stringify({readings:[reading()]}),'sensors.json',EDA);assert.equal(json[0].value,'018.00');
  assert.throws(()=>UI.parseBatch(JSON.stringify({farm:'farm-a',readings:[reading()]}),'source.json',EDA),/Farm identity and permissions/);
  assert.throws(()=>UI.parseBatch('{"readings":[],"readings":[]}','source.json',EDA),/Duplicate/);
  assert.throws(()=>UI.parseBatch('id,id\nx,y\n','bad.csv',EDA),/headers/);
  assert.throws(()=>UI.parseBatch('id,deviceId\nx,y,z\n','bad.csv',EDA),/malformed/);
  assert.throws(()=>UI.parseBatch(JSON.stringify(Array.from({length:501},()=>reading())),'large.json',EDA),/500/);
});

test('file import enforces byte bounds and rejects invalid UTF-8 before saving',async()=>{
  let read=false;await assert.rejects(()=>UI.readBatchFile({name:'large.csv',size:UI.MAX_BATCH_BYTES+1,arrayBuffer:async()=>{read=true}},EDA),/256 KiB/);assert.equal(read,false);
  await assert.rejects(()=>UI.readBatchFile({name:'bad.csv',size:1,arrayBuffer:async()=>Uint8Array.from([255]).buffer},EDA),/valid UTF-8/);
});

test('connected mode uses farmer-token GET only and never promotes demo readings into private storage',async()=>{
  const requests=[],session=UI.createSession({core:Core,now:()=>NOW,fetch:async(url,options)=>{requests.push({url,...options});return response(snapshot())}});
  session.addDemo([reading({id:'local-only'})]);assert.equal(await session.connect(token),true);assert.equal(session.state.farm,'farm-a');assert.equal(session.state.readings.length,1);assert.equal(session.state.readings[0].id,'reading-001');
  assert.throws(()=>session.addDemo([reading({id:'would-upload'})]),/registered gateways/);assert.equal(await session.refresh(),true);
  assert.equal(requests.length,2);for(const req of requests){assert.equal(req.url,'/api/sensors');assert.equal(req.method,'GET');assert.equal(req.headers.Authorization,'Bearer '+token);assert.equal(req.credentials,'omit');assert.equal(req.body,undefined)}
  assert.doesNotMatch(JSON.stringify(session.state),new RegExp(token));assert.doesNotMatch(JSON.stringify(UI.exportData(session.state,NOW)),new RegExp(token));
  session.disconnect();assert.equal(session.state.mode,'demo');assert.equal(session.state.farm,null);assert.equal(session.state.readings[0].id,'local-only');assert.equal(await session.refresh(),false);assert.equal(requests.length,2);
});

test('a rejected or mismatched farm read never replaces an existing private view',async()=>{
  let current=snapshot();const session=UI.createSession({core:Core,now:()=>NOW,fetch:async()=>response(current)});
  assert.equal(await session.connect(token),true);current=snapshot({farm:'farm-b'});assert.equal(await session.refresh(),false);assert.equal(session.state.farm,'farm-a');assert.match(session.state.error,/farm identity changed/i);
  assert.throws(()=>UI.validateSnapshot(snapshot({readings:[stored({farm:'farm-b'})]})),/different farm/);
  assert.throws(()=>UI.validateSnapshot(snapshot({role:'partner'})),/unsupported/);
  assert.throws(()=>UI.validateSnapshot(snapshot({commercialUse:'enabled'})),/unsupported/);
});

test('cancelled connection ignores a late response and keeps the local demo visible',async()=>{
  let release;const session=UI.createSession({core:Core,now:()=>NOW,fetch:()=>new Promise(resolve=>{release=resolve})});
  session.addDemo([reading({id:'local-only'})]);const pending=session.connect(token);assert.equal(session.state.busy,true);session.cancelPending();release(response(snapshot()));assert.equal(await pending,false);assert.equal(session.state.mode,'demo');assert.equal(session.state.farm,null);assert.equal(session.state.readings[0].id,'local-only');assert.equal(session.state.busy,false);
});

test('latest readings follow observation time, keep device/unit groups separate, and preserve sender quality',()=>{
  const rows=[stored({id:'recent',observedAt:'2026-10-17T11:00:00Z',quality:'ok'}),stored({id:'late-old',observedAt:'2026-10-16T11:00:00Z',receivedAt:'2026-10-17T12:30:00Z',quality:'suspect'}),stored({id:'other-device',deviceId:'sensor-south',value:'7',quality:'invalid'}),stored({id:'rain',measurement:'rainfall',unit:'mm',value:'3',quality:'unverified'})];
  const summary=UI.summarize(rows);assert.equal(summary.total,4);assert.equal(summary.devices,2);assert.equal(summary.review,2);assert.equal(summary.unverified,1);assert.equal(summary.latest.length,3);assert.ok(summary.latest.some(row=>row.id==='recent'));assert.ok(!summary.latest.some(row=>row.id==='late-old'));
  assert.deepEqual(UI.filterReadings(rows,{quality:'review'}).map(row=>row.id),['other-device','late-old']);assert.equal(UI.filterReadings(rows,{device:'sensor-north',measurement:'rainfall'})[0].unit,'mm');
});

test('exports retain source and receipt times, mark demo provenance, and contain no access grants',()=>{
  const session=UI.createSession({core:Core,now:()=>NOW});session.addDemo([reading()]);const data=UI.exportData(session.state,NOW);
  assert.equal(data.kind,'local-sensor-demo');assert.equal(data.farm,null);assert.equal(data.commercialUse,'not-enabled-by-this-module');assert.equal(data.readings[0].observedAt,'2026-10-17T10:00:00Z');assert.equal(data.readings[0].receivedAt,'2026-10-17T12:00:00.000Z');assert.equal(data.grants,undefined);data.readings[0].value='changed';assert.equal(session.state.readings[0].value,'018.00');
});

test('reading table escapes source text and displays measurement units, sender flags and both timestamps',()=>{
  const html=UI.rowsHTML([stored({field:'<img src=x onerror=alert(1)>',quality:'ok'})]);assert.match(html,/018\.00/);assert.match(html,/°C/);assert.match(html,/OK · source flag/);assert.match(html,/2026-10-17T10:00:00Z/);assert.match(html,/2026-10-17T12:00:00Z/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
});

test('sensor UI has no device credential input, automatic fake feed or private storage write path',()=>{
  const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'public/sensors.html'),'utf8'),script=fs.readFileSync(path.join(root,'public/sensors.js'),'utf8'),nav=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  assert.match(nav,/href="\/sensors\.html"/);assert.match(html,/No sensor is connected/);assert.match(html,/Device credentials stay with the gateway/);assert.match(html,/Source quality/);assert.match(html,/Measured at/);assert.match(html,/Received at/);assert.match(html,/disappear when it closes or reloads/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|method:\s*['"]POST|setInterval|SENSOR_DEVICE_ACCESS_JSON/);assert.equal((html.match(/type="password"/g)||[]).length,1);assert.match(html,/Farmer access token/);
});


test('connected capacity reports record slots with the shared byte budget and validates optional numbers',async()=>{
  const session=UI.createSession({core:Core,now:()=>NOW,fetch:async()=>response(snapshot({stateBytes:3145728,maxStateBytes:3145728}))});
  await session.connect(token);assert.match(UI.capacityNote(session.state),/Up to 9,999 further readings/);assert.match(UI.capacityNote(session.state),/shared depot storage limit also applies/);assert.match(UI.capacityNote(session.state),/3,145,728 \/ 3,145,728 bytes used/);
  const context=session.state.contextVersion;await session.refresh();assert.equal(session.state.contextVersion,context,'Refresh preserves filters within the current farm.');session.disconnect();assert.ok(session.state.contextVersion>context,'A farm context change resets the view.');
  for(const key of ['capacity','remaining','stateBytes','maxStateBytes'])assert.throws(()=>UI.validateSnapshot(snapshot({[key]:'untrusted'})),/capacity/);
});
