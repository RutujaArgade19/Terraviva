'use strict';
// A DOM facade exercises the report's real handlers and profiling API. This
// checks data/provenance behavior only; it is not a browser or visual test.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createHash,webcrypto}=require('node:crypto');
const E=require('../public/eda-engine.js');
const root=path.join(__dirname,'..');
const csv='product,volume,field,date\nwheat,1,Peña,2026-10-16\n';
function harness(options={}){
  const ids=[...fs.readFileSync(path.join(root,'report/template.html'),'utf8').matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  class Node {
    constructor(id=''){this.id=id;this.value='';this.textContent='';this.hidden=false;this.handlers={};this.classList={toggle(){},add(){},remove(){}};this._html='';}
    set innerHTML(value){this._html=value;if(/-select$/.test(this.id)){const m=String(value).match(/<option value="([^"]*)"/);this.value=m?m[1]:'';}}
    get innerHTML(){return this._html;}
    addEventListener(name,handler){this.handlers[name]=handler;}
    replaceChildren(){this.innerHTML='';this.textContent='';}
    click(){return this.handlers.click?.({target:this});}
  }
  const nodes=Object.fromEntries(ids.map(id=>[id,new Node(id)]));
  nodes['initial-dataset'].textContent='null';nodes.delimiter.value='auto';nodes['analysis-results'].hidden=true;
  const downloads=[],listeners={};
  const context={
    TerravivaEDA:E,crypto:webcrypto,TextEncoder,TextDecoder,Blob,
    setTimeout:(fn,delay)=>setTimeout(fn,delay===0?0:1),
    document:{getElementById(id){assert.ok(nodes[id],'Unknown report element: '+id);return nodes[id];},querySelectorAll(){return[];},createElement(){return new Node();}},
    location:{origin:'https://example.test',protocol:'https:'},opener:options.withOpener?{postMessage(){}}:null,addEventListener(name,handler){listeners[name]=handler;},
    URL:{createObjectURL(blob){downloads.push(blob);return'blob:test';},revokeObjectURL(){}}
  };
  context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root,'report/ui.js'),'utf8'),context);
  return{nodes,downloads,context,dispatch:event=>listeners.message(event),async profile(){nodes['download-profile'].click();assert.ok(downloads.length);return JSON.parse(await downloads.at(-1).text());}};
}
function file(bytes,name='synthetic.csv'){const blob=new Blob([bytes]);return{name,size:blob.size,arrayBuffer:()=>blob.arrayBuffer()};}

test('uploaded-byte checksum and size include a UTF-8 BOM; report renders the actual EDA API',async()=>{
  const h=harness(),bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(csv)]);
  await h.nodes['data-file'].handlers.change({target:{files:[file(bytes)]}});
  assert.match(h.nodes['analysis-status'].textContent,/Analysis complete/);
  assert.match(h.nodes['numeric-summary'].innerHTML,/Valid n/);
  const profile=await h.profile();
  assert.equal(profile.source.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(profile.source.sizeBytes,bytes.length);
  assert.equal(profile.source.decodedTextBytes,bytes.length-3);
  assert.equal(profile.source.sha256Basis,'original-file-bytes');
  assert.match(h.nodes['dataset-description'].textContent,/original file bytes/);
  assert.equal(profile.tables[0].rowCount,1);
});

test('invalid uploaded UTF-8 cannot become a report containing replacement labels',async()=>{
  const h=harness();
  const bytes=Buffer.concat([Buffer.from('product,volume,field,date\nwheat,1,Pe'),Buffer.from([0xf1]),Buffer.from('a,2026-10-16\n')]);
  await h.nodes['data-file'].handlers.change({target:{files:[file(bytes)]}});
  assert.match(h.nodes['analysis-status'].textContent,/not valid UTF-8/);
  assert.equal(h.nodes['analysis-results'].hidden,true);
  h.nodes['download-profile'].click();assert.equal(h.downloads.length,0);
});

test('pasted-source checksum explicitly identifies generated UTF-8 text',async()=>{
  const h=harness();h.nodes['pasted-data'].value=csv;
  await h.nodes['analyse-paste'].click();
  const profile=await h.profile();
  assert.equal(profile.source.sha256,createHash('sha256').update(csv,'utf8').digest('hex'));
  assert.equal(profile.source.sha256Basis,'generated-utf8-text');
  assert.match(h.nodes['dataset-description'].textContent,/generated UTF-8 text/);
});

test('clear invalidates an uploaded-file read before it finishes',async()=>{
  const h=harness();let release;
  const pendingFile={name:'synthetic.csv',size:Buffer.byteLength(csv),arrayBuffer:()=>new Promise(resolve=>{release=resolve;})};
  const pending=h.nodes['data-file'].handlers.change({target:{files:[pendingFile]}});
  h.nodes['clear-data'].click();
  release(await new Blob([csv]).arrayBuffer());await pending;
  assert.equal(h.nodes['analysis-results'].hidden,true);
  assert.match(h.nodes['analysis-status'].textContent,/Cleared/);
  h.nodes['download-profile'].click();assert.equal(h.downloads.length,0);
});

test('source messages require the exact same-origin opener and preserve reference bytes',async()=>{
  const h=harness({withOpener:true});
  const source={_terravivaDataset:{role:'reference',farmerAssignment:null},records:[{country:'ES',production:10}]};
  const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify(source))]);
  const data={type:'terraviva-source-report-data',payload:{filename:'reference.json',bytes:new Uint8Array(bytes)}};
  await h.dispatch({origin:'https://other.test',source:h.context.opener,data});
  await h.dispatch({origin:'https://example.test',source:{},data});
  assert.equal(h.nodes['analysis-results'].hidden,true);
  await h.dispatch({origin:'https://example.test',source:h.context.opener,data});
  assert.match(h.nodes['analysis-status'].textContent,/Analysis complete/);
  assert.equal(h.nodes['dataset-kind'].textContent,'Reference source · unassigned');
  const profile=await h.profile();
  assert.equal(profile.evidenceKind,'reference');
  assert.equal(profile.source.sha256Basis,'original-file-bytes');
  assert.equal(profile.source.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(profile.source.sizeBytes,bytes.length);
});

test('source messages validate filename, byte representation, bounds and UTF-8 before analysis',async()=>{
  const h=harness({withOpener:true});
  const send=payload=>h.dispatch({origin:'https://example.test',source:h.context.opener,data:{type:'terraviva-source-report-data',payload}});
  const validBytes=new TextEncoder().encode(csv);
  await send({filename:'../private.csv',bytes:validBytes});assert.match(h.nodes['analysis-status'].textContent,/filename/);
  await send({filename:'input.csv',bytes:[1,2]});assert.match(h.nodes['analysis-status'].textContent,/ArrayBuffer or Uint8Array/);
  await send({filename:'input.csv',bytes:new Uint8Array(E.limits.maxFileBytes+1)});assert.match(h.nodes['analysis-status'].textContent,/20 MiB/);
  await send({filename:'input.csv',bytes:new Uint8Array([0xff])});assert.match(h.nodes['analysis-status'].textContent,/not valid UTF-8/);
  assert.equal(h.nodes['analysis-results'].hidden,true);
  // Invalid source messages do not consume the existing depot handshake.
  const depot={farm:'farm-a',records:[{product:'wheat',volume:2,field:'North',date:'2026-10-16'}]};
  await h.dispatch({origin:'https://example.test',source:h.context.opener,data:{type:'terraviva-report-data',payload:depot}});
  const profile=await h.profile();assert.equal(profile.evidenceKind,'depot');
  assert.equal(profile.source.sha256Basis,'generated-utf8-text');
});
