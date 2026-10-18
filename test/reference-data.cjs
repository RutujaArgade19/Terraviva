'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash,webcrypto}=require('node:crypto');
const {gzipSync}=require('node:zlib');
const fs=require('node:fs');
const path=require('node:path');
const R=require('../public/reference-data.js');
const checksum=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
  const dataset={id:'fixture',title:'Synthetic test source',source:{path:'test/fixture.csv',bytes:1234,sha256:'a'.repeat(64)},role:'reference',farmerAssignment:null,rowCount:7,columns:['id','year','country_code','operation_type','native_crop_code','quantity','quantity_unit'],pages:[]};
  const rows=[['9007199254740993','2021','ES','planting','COWT','001.20','t'],['02','2022','FR','harvest','MAIZ',null,'t'],['03','2021','ES','planting','COWT','','t'],['04','2023','ES','planting','BARL',' 5 ','t'],['05','2021','ES','planting','COWT','6','t'],['06','2021','FR','harvest','MAIZ','7','t'],['07','2021','ES','planting','COWT','8','t']];
  const payloads=new Map();let firstRow=1;
  for(let i=0;i<rows.length;i+=3){
    const part=rows.slice(i,i+3),page={datasetId:dataset.id,role:'reference',farmerAssignment:null,columns:dataset.columns,rows:part,firstRow,lastRow:firstRow+part.length-1},decoded=Buffer.from(JSON.stringify(page)),compressed=gzipSync(decoded),file='fixture/page-'+String(dataset.pages.length+1).padStart(6,'0')+'.json.gz';
    const descriptor={file,firstRow,lastRow:page.lastRow,rows:part.length,bytes:compressed.length,decodedBytes:decoded.length,sha256:checksum(compressed),decodedSha256:checksum(decoded)};
    dataset.pages.push(descriptor);payloads.set(file,{page,decoded,compressed});firstRow+=part.length;
  }
  return {dataset,rows,payloads,catalog:{kind:'terraviva-reference-catalog',schemaVersion:1,scope:{completeForRetrievedFiles:true,originalArchiveCoverage:'unknown'},datasets:[dataset]}};
}
function loader(f,events=[]){return(dataset,page,{signal}={})=>{events.push(page.file);return R.loadPage(dataset,page,{signal,origin:'https://example.test',crypto:webcrypto,fetch:async url=>new Response(f.payloads.get(url.pathname.replace('/reference/','')).compressed)})}}

test('reference catalogue rejects incomplete coverage, reassignment, unsafe paths and missing integrity',()=>{
  const {catalog}=fixture();assert.equal(R.validateCatalog(catalog),catalog);
  const bad=mutation=>{const copy=structuredClone(catalog);mutation(copy.datasets[0]);assert.throws(()=>R.validateCatalog(copy))};
  bad(d=>{d.rowCount++});bad(d=>{d.pages[1].firstRow++});bad(d=>{d.farmerAssignment='farm-a'});bad(d=>{delete d.role});bad(d=>{d.pages[0].sha256='unchecked'});bad(d=>{d.columns[1]=d.columns[0]});
  for(const file of ['../api/depot','/reference/a','https://elsewhere.test/a','//elsewhere.test/a','a%2fb.json.gz','a\\b','a/./b','a//b','a.json.gz?token=1'])assert.throws(()=>R.safeAssetURL(file,'https://example.test'));
  assert.equal(R.safeAssetURL('source-01/page-000001.json.gz','https://example.test').href,'https://example.test/reference/source-01/page-000001.json.gz');
});

test('native gzip loading verifies compressed and decoded bytes and retains every source character',async()=>{
  const f=fixture(),page=await loader(f)(f.dataset,f.dataset.pages[0]);
  assert.deepEqual(page.rows,f.rows.slice(0,3));assert.equal(page.rows[0][0],'9007199254740993');assert.equal(page.rows[0][5],'001.20');assert.equal(page.rows[1][5],null);assert.equal(page.rows[2][5],'');
  const whitespace=await loader(f)(f.dataset,f.dataset.pages[1]);assert.equal(whitespace.rows[0][5],' 5 ');
  const corrupt=structuredClone(f.dataset.pages[0]);corrupt.sha256='b'.repeat(64);
  await assert.rejects(()=>loader(f)(f.dataset,corrupt),/compressed page/);
  const wrongDecoded=structuredClone(f.dataset.pages[0]);wrongDecoded.decodedSha256='b'.repeat(64);
  await assert.rejects(()=>loader(f)(f.dataset,wrongDecoded),/decoded page/);
});

test('valid hashes cannot authorize changed scalar types, source positions or farmer assignment',async()=>{
  const f=fixture(),descriptor=f.dataset.pages[0],original=f.payloads.get(descriptor.file).page;
  for(const mutate of [p=>{p.rows[0][0]=9007199254740992},p=>{p.firstRow=2},p=>{p.farmerAssignment='farm-a'},p=>{p.columns.reverse()},p=>{p.sourceLines=[1,2,99]}]){
    const page=structuredClone(original);mutate(page);const decoded=Buffer.from(JSON.stringify(page)),compressed=gzipSync(decoded),metadata={...descriptor,bytes:compressed.length,decodedBytes:decoded.length,sha256:checksum(compressed),decodedSha256:checksum(decoded)};
    await assert.rejects(()=>R.loadPage(f.dataset,metadata,{origin:'https://example.test',crypto:webcrypto,fetch:async()=>new Response(compressed)}),/catalogue|source values|positions/);
  }
});

test('bounded reads reject oversized streams and invalid UTF-8 before parsing',async()=>{
  await assert.rejects(()=>R.readBounded(new Response(new Uint8Array(101)),100),/expected size/);
  assert.throws(()=>R.decodeJSON(Uint8Array.from([0x22,0xff,0x22])),/UTF-8/);
  const controller=new AbortController();controller.abort();await assert.rejects(()=>R.readBounded(new Response('abc'),3,controller.signal),{name:'AbortError'});
});

test('whole-source filters scan the last page, preserve positions, and retain only a display window',async()=>{
  const f=fixture(),events=[],explorer=R.createExplorer({loadPage:loader(f,events),viewRows:2,yieldControl:async()=>{}});
  await explorer.select(f.dataset);assert.deepEqual(explorer.state.rows.map(r=>r.sourceRow),[1,2]);events.length=0;
  await explorer.applyFilters({operation:'PLANTING',country:'es',year:'2021',crop:'cowt'});
  assert.equal(events.length,3,'Every source page must be scanned.');assert.equal(explorer.state.total,4);assert.deepEqual(explorer.state.matchCounts,[2,1,1]);assert.deepEqual(explorer.state.rows.map(r=>r.sourceRow),[1,3]);assert.equal(explorer.state.rows.length,2);
  await explorer.goTo(2);assert.deepEqual(explorer.state.rows.map(r=>r.sourceRow),[5,7]);assert.equal(explorer.state.rows[1].values[0],'07');
  await explorer.applyFilters({text:'9007199254740993'});assert.equal(explorer.state.total,1);assert.equal(explorer.state.rows[0].sourceRow,1);
  await explorer.applyFilters({});assert.equal(explorer.state.total,7);assert.equal(explorer.state.matchCounts,null);assert.deepEqual(explorer.state.rows.map(r=>r.sourceRow),[1,2]);assert.equal(explorer.state.dataset.farmerAssignment,null);
});

test('cancelling a full-source scan leaves previous results intact and ignores late responses',async()=>{
  const f=fixture();let release,scan=false;
  const baseLoader=loader(f),explorer=R.createExplorer({viewRows:2,yieldControl:async()=>{},loadPage:async(dataset,page,options)=>{if(scan&&page===dataset.pages[1])await new Promise(resolve=>{release=resolve});return baseLoader(dataset,page,options)}});
  await explorer.select(f.dataset);const before=structuredClone(explorer.state.rows);scan=true;
  const pending=explorer.applyFilters({country:'ES'});while(!release)await new Promise(resolve=>setImmediate(resolve));
  explorer.cancel();assert.equal(explorer.state.busy,false);assert.equal(explorer.state.total,7);assert.deepEqual(explorer.state.rows,before);release();await pending;
  assert.equal(explorer.state.total,7);assert.deepEqual(explorer.state.rows,before);assert.match(explorer.state.notice,/previous results are unchanged/);assert.equal(explorer.state.matchCounts,null);
});

test('filters use explicit source columns and never infer an annual year from another field',()=>{
  const matches=R.matcher(['operation_date','country_code','crop_group_code','native_crop_code'],{country:'es',crop:'cowt'});
  assert.equal(matches(['2021-12-31','ES','CEREALS','COWT']),true);
  assert.throws(()=>R.matcher(['operation_date'],{year:'2021'}),/no year field/);
  assert.equal(R.matcher(['year'],{year:'2021'})(['20210']),false);
  assert.equal(R.matcher(['year'],{year:'2021'})([null]),false);
});

test('record details include all columns, original text, adjacent units and source qualifications',()=>{
  const dataset={columns:['id','quantity','quantity_unit','static_head_count','temporal_basis','value_eur','farm_value_status','structure_time_status','avg_number','livestock_temporal_basis','empty','missing','unsafe']},record={sourceRow:1,values:['9007199254740993','4.00','1000 pieces','2.5','static_source_denominator','0012.30','synthetic_not_regionally_recalibrated','static_source_structure_and_labour','4.5','static_source_inventory','',null,'<img src=x onerror=alert(1)>']};
  const html=R.detailsHTML(dataset,record,{columns:[{name:'id',description:'Identifier <not a number>'}]});
  assert.equal((html.match(/class="field-detail"/g)||[]).length,dataset.columns.length);assert.match(html,/9007199254740993/);assert.match(html,/4\.00/);assert.match(html,/0012\.30/);assert.match(html,/Unit: 1000 pieces/);assert.match(html,/Value status: synthetic_not_regionally_recalibrated/);assert.match(html,/Structure: static_source_structure_and_labour/);assert.match(html,/Basis: static_source_inventory/);assert.match(html,/Empty text/);assert.match(html,/NULL/);assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(html,/<img/);
  const withUnits=R.detailsHTML({columns:['uaa_ha','total_labour_awu']},{sourceRow:1,values:['3.1','2']},{columns:[{name:'uaa_ha',unit:'ha'},{name:'total_labour_awu',unit:'AWU'}]});assert.match(withUnits,/Unit: ha/);assert.match(withUnits,/Unit: AWU/);
  const row=Object.fromEntries(dataset.columns.map((name,i)=>[name,record.values[i]]));assert.match(R.cellHTML('quantity',row.quantity,row),/1000 pieces/);assert.match(R.cellHTML('value_eur',row.value_eur,row),/synthetic_not_regionally_recalibrated/);assert.match(R.cellHTML('avg_number',row.avg_number,row),/static_source_inventory/);
});

test('workspace navigation exposes the explorer without a farmer import or consent action',()=>{
  const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'public/reference-data.html'),'utf8'),navigation=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  assert.match(navigation,/href="\/reference-data\.html"/);assert.match(html,/does not add records to a farmer/);assert.match(html,/files overlap|Source files overlap/i);assert.match(html,/original release has not been fully inventoried/);assert.match(html,/reference-data\.js/);
  const script=fs.readFileSync(path.join(root,'public/reference-data.js'),'utf8');assert.doesNotMatch(script,/localStorage|\/api\/depot|\/api\/sms|TerraImport\.commit|method:\s*['"]POST/);
});
