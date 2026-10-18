'use strict';
// Synthetic fixtures only. The DOM facade runs the real dashboard entry point
// and its browser scripts; it checks data/privacy outcomes, not visual layout.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const Summary=require('../public/sensor-summary.js');
const Core=require('../public/core.js');
const root=path.join(__dirname,'..');
const NOW=Date.parse('2026-10-18T12:00:00Z');
const TOKEN='synthetic-farmer-token-not-a-real-credential-0123456789';
const row=(overrides={})=>({id:'reading-001',deviceId:'sensor-north',field:'North field',observedAt:'2026-10-18T10:00:00Z',measurement:'soil_moisture',value:'023.500',unit:'%',quality:'unverified',receivedAt:'2026-10-18T10:01:00Z',...overrides});
const sensors=(readings=[])=>({version:1,readings});
const record=product=>({id:'harvest-'+product,product,volume:12,field:'North field',date:'2026-10-18'});
const depot=(overrides={})=>({farm:'farm-a',state:{...Core.initial(),records:[record('private-wheat')],sensors:sensors([row()])},...overrides});
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(data)});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject};}

function dashboard({localState,fetch:handleFetch=async()=>{throw Error('Unexpected network request')}}={}){
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const nodes=new Map(),listeners={},downloads=[],requests=[],storageWrites=[];
  const storage=new Map(localState?[['terraviva-v2',JSON.stringify(localState)]]:[]);
  let dynamicIds=[];
  class Element{
    constructor(id='',attrs=''){
      this.id=id;this.value='';this.textContent='';this.disabled=/\bdisabled\b/.test(attrs);this.hidden=/\bhidden\b/.test(attrs);this.dataset={};this.open=false;this._html='';
      this.classList={toggle(){},add(){},remove(){}};
      this.attributes=new Set([...attrs.matchAll(/\b(data-[\w-]+)(?:="([^"]*)")?/g)].map(match=>{this.dataset[match[1].slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=match[2]||'';return match[1];}));
    }
    set innerHTML(value){
      this._html=String(value);
      if(this.id==='content'){
        for(const id of dynamicIds)nodes.delete(id);dynamicIds=[];
        for(const match of this._html.matchAll(/<[a-z][\w-]*\b([^>]*\bid="([^"]+)"[^>]*)>/g)){nodes.set(match[2],new Element(match[2],match[1]));dynamicIds.push(match[2]);}
      }
    }
    get innerHTML(){return this._html;}
    insertAdjacentHTML(position,html){assert.equal(position,'afterbegin');this._html=html+this._html;}
    hasAttribute(name){return this.attributes.has(name);}
    closest(selector){return selector==='button'?this:null;}
    showModal(){this.open=true;}
    close(){this.open=false;}
    click(){if(this.disabled)return;const event={target:this,preventDefault(){}};const result=this.onclick?.(event);listeners.click?.(event);return result;}
  }
  for(const match of html.matchAll(/<[a-z][\w-]*\b([^>]*\bid="([^"]+)"[^>]*)>/g))nodes.set(match[2],new Element(match[2],match[1]));
  const nav=[...html.matchAll(/<button\b([^>]*\bdata-view="[^"]+"[^>]*)>/g)].map(match=>new Element('',match[1]));
  const document={
    querySelector(selector){if(selector==='.messages')return{scrollTop:0,scrollHeight:0};assert.ok(selector.startsWith('#'),'Unsupported selector '+selector);assert.ok(nodes.has(selector.slice(1)),'Missing dashboard element '+selector);return nodes.get(selector.slice(1));},
    querySelectorAll(selector){assert.equal(selector,'nav button');return nav;},
    addEventListener(name,handler){listeners[name]=handler;},
    createElement(tag){assert.equal(tag,'a');return{click(){}};}
  };
  const context={document,Blob,TextEncoder,TextDecoder,structuredClone,crypto:webcrypto,AbortController,
    location:{origin:'https://terraviva.example',protocol:'https:'},
    localStorage:{getItem:key=>storage.get(key)??null,setItem(key,value){storageWrites.push({key,value});storage.set(key,value);}},
    fetch:async(url,options)=>{requests.push({url,...options});return handleFetch(url,options);},
    URL:{createObjectURL(blob){downloads.push(blob);return'blob:synthetic-export';},revokeObjectURL(){}},
    setTimeout(){return 1;},clearTimeout(){},
    addEventListener(name,handler){listeners[name]=handler;},open(){return{postMessage(){}};}
  };
  context.window=context;vm.createContext(context);
  // Loading the scripts declared by the actual HTML also catches missing or
  // misordered dependencies in the shipped entry point.
  for(const match of html.matchAll(/<script\s+src="\/([^"]+)"[^>]*><\/script>/g))vm.runInContext(fs.readFileSync(path.join(root,'public',match[1]),'utf8'),context,{filename:match[1]});
  const element=id=>document.querySelector('#'+id);
  return{element,downloads,requests,storage,storageWrites,
    content:()=>element('content').innerHTML,
    navigate(view){const button=nav.find(item=>item.dataset.view===view);assert.ok(button,'Missing view '+view);button.click();},
    connect(candidate=TOKEN){element('connect').click();element('token').value=candidate;return element('login-form').onsubmit({preventDefault(){}});},
    refresh:()=>vm.runInContext('refreshDepot()',context),
    submit:text=>vm.runInContext('submit('+JSON.stringify(text)+')',context),
    disconnect(){element('connect').click();},
    async exportSensors(){element('export-sensors').click();assert.ok(downloads.length,'No export was created');return JSON.parse(await downloads.at(-1).text());}
  };
}

test('returning empty demo loads a coherent sample across views and SMS updates the same wallet',async()=>{
  const h=dashboard({localState:Core.initial()});
  assert.match(h.content(),/24\.30/);assert.match(h.content(),/Ana García/);assert.match(h.content(),/ILLUSTRATIVE SENSOR SNAPSHOT/);
  h.navigate('depot');assert.match(h.content(),/Hillside Grove/);assert.match(h.content(),/12\.4 t/);
  h.navigate('permissions');assert.match(h.content(),/Access is active/);
  h.navigate('activity');assert.match(h.content(),/Harvest confirmed/);
  h.navigate('industry');assert.match(h.content(),/122 t/);assert.match(h.content(),/SEPARATE SYNTHETIC COHORT/);
  h.navigate('sms');assert.match(h.content(),/3 harvest records \(24\.30 tonnes\)/);
  await h.submit('Harvested 2 tonnes of wheat from North Field');await h.submit('YES');
  h.navigate('overview');assert.match(h.content(),/26\.30/);
  assert.equal(h.requests.length,0);assert.equal(JSON.parse(h.storage.get('terraviva-v2')).records.length,4);
});

test('sample never populates a connected private depot and disconnect restores the browser example',async()=>{
  const h=dashboard({localState:Core.initial(),fetch:async()=>response({farm:'empty-private',state:Core.initial()})});
  await h.connect();assert.doesNotMatch(h.content(),/Ana García|ILLUSTRATIVE SENSOR SNAPSHOT/);
  h.navigate('depot');assert.match(h.content(),/No harvests yet/);
  h.navigate('industry');assert.doesNotMatch(h.content(),/SEPARATE SYNTHETIC COHORT/);
  h.disconnect();h.navigate('overview');assert.match(h.content(),/24\.30/);
  assert.equal(h.storageWrites.length,0);
});

test('browser migration preserves meaningful or unknown saved state',()=>{
  for(const saved of [{...Core.initial(),events:[{text:'Deleted my records'}]}, {...Core.initial(),commercial:true}, {...Core.initial(),sensors:{version:1,readings:[]}}, {...Core.initial(),pending:{kind:'harvest'}}, {...Core.initial(),processed:{id:'reply'}}, {...Core.initial(),futureField:true}])assert.equal(Core.browserDemo(saved),saved);
  assert.equal(Core.initial().records.length,0);assert.equal(Core.browserDemo(null).records.length,3);
});

test('disconnected dashboard never reads or presents sensor values from local demo state',()=>{
  const poisoned={get version(){throw Error('Disconnected sensor data must not be inspected');}};
  assert.doesNotThrow(()=>Summary.render(poisoned));
  const localState={...Core.initial(),records:[record('local-barley')],sensors:sensors([row({field:'hidden-demo-field',value:'99999.87654'})])};
  const h=dashboard({localState});
  for(const view of ['overview','depot']){
    h.navigate(view);assert.match(h.content(),/Connect your private depot/);assert.match(h.content(),/local-barley/);
    assert.doesNotMatch(h.content(),/hidden-demo-field|99999\.87654|export-sensors/);
  }
  assert.equal(h.element('refresh-depot').hidden,true);assert.equal(h.requests.length,0);assert.equal(h.storageWrites.length,0);
});

test('latest observations stay separate by device, field and measurement despite delayed arrivals and timezone spellings',()=>{
  const rows=[
    row({id:'new-observation',observedAt:'2026-10-18T12:00:00+02:00'}),
    row({id:'late-old-observation',observedAt:'2026-10-18T09:30:00Z',receivedAt:'2026-10-18T12:00:00Z',quality:'suspect'}),
    row({id:'same-instant-later-receipt',observedAt:'2026-10-18T10:00:00Z',receivedAt:'2026-10-18T10:02:00Z',quality:'ok'}),
    row({id:'different-field',field:'South field'}),
    row({id:'different-device',deviceId:'sensor-south',quality:'invalid'}),
    row({id:'different-measurement',measurement:'rainfall',unit:'mm',value:'0003.20'})
  ];
  const result=Summary.summarize(sensors(rows));
  assert.equal(result.total,6);assert.equal(result.devices,2);assert.equal(result.review,2);assert.equal(result.lastReceived,'2026-10-18T12:00:00Z');
  assert.deepEqual(new Set(result.latest.map(item=>item.id)),new Set(['same-instant-later-receipt','different-field','different-device','different-measurement']));
  assert.equal(result.latest[0].id,'same-instant-later-receipt');
});

test('summary preserves lexical values and distinct physical units while labelling sender quality accurately',()=>{
  const data=sensors([
    row({quality:'ok'}),row({id:'temperature',measurement:'soil_temperature',value:'018.00',unit:'°C',quality:'suspect'}),
    row({id:'radiation',measurement:'solar_radiation',value:'1.20e+3',unit:'W/m²',quality:'invalid'}),
    row({id:'rain',measurement:'rainfall',value:'0003.20',unit:'mm'})
  ]);
  const html=Summary.render(data,{connected:true,farm:'farm-a'});
  for(const value of ['023.500 %','018.00 °C','1.20e+3 W/m²','0003.20 mm','OK · source flag','Suspect','Invalid','Unverified'])assert.ok(html.includes(value),'Missing source value or quality label: '+value);
  assert.match(html,/quality flags are not farmer approval/);assert.match(html,/snapshot/);
  assert.match(html,/commercial aggregation are not enabled/);
});

test('hostile field and identity labels are escaped in the sensor summary',()=>{
  const html=Summary.render(sensors([row({deviceId:'<svg onload="alert(1)">',field:'<img src=x onerror="alert(2)"> & Peña'})]),{connected:true,farm:'<script>alert(3)</script>'});
  assert.match(html,/&lt;svg onload=&quot;alert\(1\)&quot;&gt;/);assert.match(html,/&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt; &amp; Peña/);assert.match(html,/&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<(?:svg|img|script)\b/);
});

test('sensor export contains every reading but strips credentials, grants and other depot data',()=>{
  const readings=Array.from({length:8},(_,index)=>row({id:'reading-'+index,deviceId:'device-'+index,value:'00'+index+'.500',token:TOKEN,grants:[{recipient:'should-not-be-exported'}]}));
  const source={...sensors(readings),credentials:TOKEN,grants:['private-grant']};
  const html=Summary.render(source,{connected:true,farm:'farm-a'});assert.match(html,/Showing 6 of 8/);
  const result=Summary.exportHistory(source,'farm-a',NOW);
  assert.equal(result.kind,'private-sensor-data');assert.equal(result.farm,'farm-a');assert.equal(result.exportedAt,'2026-10-18T12:00:00.000Z');assert.equal(result.commercialUse,'not-enabled-by-this-module');assert.equal(result.readings.length,8);
  assert.equal(result.readings[7].value,'007.500');assert.equal(result.readings[0].observedAt,readings[0].observedAt);assert.equal(result.readings[0].receivedAt,readings[0].receivedAt);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-farmer-token|grants|credentials|should-not-be-exported/);
  result.readings[0].value='changed';assert.equal(source.readings[0].value,'000.500');
});

test('unsupported sensor schemas and partner responses are rejected before entering a private dashboard',()=>{
  assert.throws(()=>Summary.validateDepot({records:[]}),/farmer token/);
  assert.throws(()=>Summary.validateDepot(depot({farm:'farm-b'}),'farm-a'),/farm identity changed/);
  for(const invalid of [null,{version:2,readings:[]},sensors([row({unit:'F'})]),sensors([row({quality:'farmer-approved'})]),sensors([row({observedAt:'2026-10-18T10:00:00'})]),sensors([row({receivedAt:'2026-02-30T10:00:00Z'})])]){
    const data=depot();data.state.sensors=invalid;assert.throws(()=>Summary.validateDepot(data));
  }
  const legacy=depot();delete legacy.state.sensors;assert.doesNotThrow(()=>Summary.validateDepot(legacy));
  const html=Summary.render(undefined,{connected:true,farm:'farm-a'});assert.match(html,/No sensor readings have arrived/);assert.doesNotMatch(html,/export-sensors/);
});

test('real dashboard connect, sensor export and disconnect keep private readings out of browser storage',async()=>{
  const localState={...Core.initial(),records:[record('local-barley')],sensors:sensors([row({value:'99999.87654'})])};
  const remote=depot();remote.state.grants=[{recipient:'COOP',expires:'2099-01-01T00:00:00Z',fields:['product']}];remote.state.sensors.readings[0].credential=TOKEN;
  const h=dashboard({localState,fetch:async()=>response(remote)});
  await h.connect();
  assert.equal(h.element('identity').textContent,'farm-a');assert.equal(h.element('token').value,'');assert.equal(h.element('login').open,false);assert.equal(h.element('refresh-depot').hidden,false);
  for(const view of ['overview','depot']){h.navigate(view);assert.match(h.content(),/023\.500 %/);assert.match(h.content(),/private-wheat/);assert.doesNotMatch(h.content(),/local-barley|99999\.87654/);}
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/depot');assert.equal(h.requests[0].method,'POST');assert.equal(h.requests[0].headers.Authorization,'Bearer '+TOKEN);assert.deepEqual(JSON.parse(h.requests[0].body),{action:'read'});
  const exported=await h.exportSensors();assert.equal(exported.farm,'farm-a');assert.equal(exported.readings[0].value,'023.500');assert.doesNotMatch(JSON.stringify(exported),/private-wheat|grants|credential|synthetic-farmer-token/);
  h.disconnect();assert.equal(h.element('identity').textContent,'Demo farm');assert.equal(h.element('refresh-depot').hidden,true);assert.match(h.content(),/local-barley/);assert.doesNotMatch(h.content(),/private-wheat|023\.500|99999\.87654|export-sensors/);
  await h.refresh();assert.equal(h.requests.length,1);assert.equal(h.storageWrites.length,0);assert.equal(h.storage.get('terraviva-v2'),JSON.stringify(localState));
});

test('navigation during authentication leaves demo sensor data unpromoted until a farmer read succeeds',async()=>{
  const wait=deferred(),localState={...Core.initial(),sensors:sensors([row({field:'secret-demo-field',value:'99999.87654'})])};
  const h=dashboard({localState,fetch:()=>wait.promise});
  const connecting=h.connect();
  h.navigate('depot');assert.match(h.element('mode').textContent,/Browser demo/);assert.equal(h.element('identity').textContent,'Demo farm');assert.equal(h.element('refresh-depot').hidden,true);assert.doesNotMatch(h.content(),/secret-demo-field|99999\.87654|export-sensors/);
  wait.resolve(response(depot()));await connecting;assert.match(h.content(),/023\.500 %/);assert.equal(h.element('identity').textContent,'farm-a');assert.equal(h.storageWrites.length,0);
});

test('refresh shows busy controls, blocks overlapping requests and returns newly arrived readings to both farm views',async()=>{
  const wait=deferred();let calls=0;const h=dashboard({fetch:()=>++calls===1?Promise.resolve(response(depot())):wait.promise});
  await h.connect();const refreshing=h.refresh();
  assert.equal(h.element('refresh-depot').disabled,true);assert.match(h.content(),/data-refresh-depot disabled/);assert.match(h.content(),/id="export-sensors" disabled/);
  await h.refresh();assert.equal(h.requests.length,2,'An overlapping refresh must not send a second request');
  h.disconnect();assert.equal(h.element('identity').textContent,'farm-a');assert.match(h.element('status').textContent,/Wait for the current request/);
  const refreshed=depot();refreshed.state.records=[record('updated-private-wheat')];refreshed.state.sensors.readings.push(row({id:'newly-arrived',value:'027.250',observedAt:'2026-10-18T11:00:00Z',receivedAt:'2026-10-18T11:01:00Z'}));
  wait.resolve(response(refreshed));await refreshing;
  assert.equal(h.element('refresh-depot').disabled,false);assert.match(h.element('status').textContent,/Depot refreshed/);
  for(const view of ['overview','depot']){h.navigate(view);assert.match(h.content(),/027\.250 %/);assert.match(h.content(),/updated-private-wheat/);assert.doesNotMatch(h.content(),/023\.500 %/);}
  assert.equal((await h.exportSensors()).readings.length,2);assert.equal(h.storageWrites.length,0);
});

test('a failed refresh retains the previous snapshot, clears loading and permits a later retry',async()=>{
  let attempt=0;const h=dashboard({fetch:async()=>{attempt++;if(attempt===2)return response({error:'Synthetic storage outage'},503);return response(depot());}});
  await h.connect();await h.refresh();
  assert.match(h.element('status').textContent,/Refresh failed: Synthetic storage outage/);assert.match(h.element('status').textContent,/Existing records are unchanged/);assert.match(h.content(),/023\.500 %/);assert.equal(h.element('identity').textContent,'farm-a');assert.equal(h.element('refresh-depot').disabled,false);
  await h.refresh();assert.equal(h.requests.length,3);assert.match(h.element('status').textContent,/Depot refreshed/);assert.equal(h.storageWrites.length,0);
});

test('a different farm returned on refresh cannot replace or persist the connected farmer’s snapshot',async()=>{
  const localState={...Core.initial(),records:[record('local-barley')]};let reads=0;
  const other=depot({farm:'farm-b'});other.state.records=[record('other-farm-private-crop')];other.state.sensors=sensors([row({value:'99999.12345'})]);
  const h=dashboard({localState,fetch:async()=>response(++reads===1?depot():other)});
  await h.connect();await h.refresh();
  assert.equal(h.element('identity').textContent,'farm-a');assert.match(h.element('status').textContent,/farm identity changed/);assert.match(h.content(),/private-wheat/);assert.match(h.content(),/023\.500 %/);assert.doesNotMatch(h.content(),/other-farm-private-crop|99999\.12345/);
  const exported=await h.exportSensors();assert.equal(exported.farm,'farm-a');assert.equal(exported.readings[0].value,'023.500');assert.equal(h.storageWrites.length,0);assert.equal(h.storage.get('terraviva-v2'),JSON.stringify(localState));
  h.disconnect();assert.doesNotMatch(h.content(),/private-wheat|99999\.12345|023\.500/);
});

test('malformed sensor history on refresh cannot replace an already validated farm view',async()=>{
  const malformed=depot();malformed.state.sensors=sensors([row({value:'091.00',unit:'unsupported-unit'})]);let reads=0;
  const h=dashboard({fetch:async()=>response(++reads===1?depot():malformed)});await h.connect();await h.refresh();
  assert.match(h.element('status').textContent,/Refresh failed/);assert.match(h.content(),/023\.500 %/);assert.doesNotMatch(h.content(),/091\.00|unsupported-unit/);assert.equal(h.element('refresh-depot').disabled,false);assert.equal(h.storageWrites.length,0);
});

test('a scoped partner response cannot connect the farmer dashboard or expose sensor values',async()=>{
  const localState={...Core.initial(),sensors:sensors([row({value:'99999.87654'})])};
  const h=dashboard({localState,fetch:async()=>response({records:[record('scoped-partner-record')]})});
  await h.connect();assert.match(h.element('login-error').textContent,/farmer token/);assert.match(h.element('mode').textContent,/Browser demo/);assert.equal(h.element('identity').textContent,'Demo farm');assert.equal(h.element('refresh-depot').hidden,true);assert.doesNotMatch(h.content(),/99999\.87654|scoped-partner-record|export-sensors/);assert.equal(h.storageWrites.length,0);
});
