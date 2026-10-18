// Synthetic cases for the real parser -> UI mapping -> import boundary.
// These do not constitute a farm dataset or a browser rendering test.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../public/eda-engine.js');
const U=require('../public/import-ui.js');
const I=require('../public/harvest-import.js');
const C=require('../public/core.js');
const analyze=(text,filename='input.json')=>E.analyzeText(text,{filename});
const example={id:'0001',product:'Wheat',volume:12,field:'North',date:'2026-10-16'};
const context={farm:'farm-a',sourceName:'harvest.json',sourceKind:'dataset'};

test('canonical export maps original rows and preserves farm ownership',()=>{
  const a=analyze(JSON.stringify({farm:'farm-a',records:[example]}));
  const t=a.tables.find(table=>table.name==='records');
  const rows=U.mappedRows(t,U.defaults(t),'farm-a',U.claimsIn(a.sourceData));
  assert.equal(rows[0].volume,12);
  assert.equal(rows[0].id,'0001');
  assert.equal(rows[0].farm,'farm-a');
  const plan=I.prepare(rows,context),state=C.initial();
  state.commercial=true;
  const result=I.commit(state,plan,1);
  assert.equal(result.added,1);
  assert.equal(state.records.length,0);
  assert.equal(result.state.commercial,true);
});

test('quantity without explicit units cannot produce an import plan',()=>{
  const a=analyze('product,quantity,field,date\nwheat,1250,North,2026-10-16\n','test.csv');
  assert.throws(()=>U.mappedRows(a.tables[0],U.defaults(a.tables[0]),'farm-a'),/explicit quantity unit/);
});

test('explicit kilogram mapping reaches the canonical tonne converter unchanged',()=>{
  const a=analyze('product,quantity,field,date\nwheat,1250,North,2026-10-16\n','test.csv');
  const mapping=U.defaults(a.tables[0]);mapping.unitMode='kg';
  const rows=U.mappedRows(a.tables[0],mapping,'farm-a');
  assert.equal(rows[0].quantity,'1250');
  assert.equal(I.prepare(rows,context).totalTonnes,1.25);
});

test('canonical volume cannot hide a conflicting source unit by dropping its mapping',()=>{
  const a=analyze('product,volume,unit,field,date\nwheat,1250,kg,North,2026-10-16\n','test.csv');
  const mapping=U.defaults(a.tables[0]);mapping.unit='';
  assert.throws(()=>U.mappedRows(a.tables[0],mapping,'farm-a'),/non-tonne unit/);
});

test('mismatched farm envelope is blocked before any row is prepared',()=>{
  const a=analyze(JSON.stringify({farm:'farm-b',records:[example]}));
  const t=a.tables[0];
  assert.throws(()=>U.mappedRows(t,U.defaults(t),'farm-a',U.claimsIn(a.sourceData)),/does not match/);
});

test('row ownership cannot be removed through optional mapping controls',()=>{
  const a=analyze(JSON.stringify([{...example,farm_id:'farm-b'}]));
  const mapping=U.defaults(a.tables[0]);mapping.farm='';
  assert.throws(()=>U.mappedRows(a.tables[0],mapping,'farm-a'),/does not match/);
});

test('original import metadata also enforces farm ownership',()=>{
  const a=analyze(JSON.stringify([{...example,importMeta:{farm:'farm-b'}}]));
  assert.throws(()=>U.mappedRows(a.tables[0],U.defaults(a.tables[0]),'farm-a'),/does not match/);
});

test('malformed CSV cannot silently import a shortened or widened row',()=>{
  const a=analyze('product,volume,field,date\nwheat,2,North,2026-10-16,extra\n','bad.csv');
  assert.throws(()=>U.mappedRows(a.tables[0],U.defaults(a.tables[0]),'farm-a'),error=>/malformed rows/.test(error.message)&&Array.isArray(error.issues)&&error.issues.length>0);
});

test('large JSON identifiers retain their original digits through mapping',()=>{
  const a=analyze('[{"id":9007199254740993,"product":"wheat","volume":2,"field":"North","date":"2026-10-16"}]');
  const rows=U.mappedRows(a.tables[0],U.defaults(a.tables[0]),'farm-a');
  assert.equal(rows[0].id,'9007199254740993');
  assert.equal(I.prepare(rows,context).records[0].importMeta.originalId,'9007199254740993');
});

test('unrelated statistics table does not receive invented harvest mappings',()=>{
  const a=analyze('[{"country":"ES","price":22}]');
  assert.throws(()=>U.mappedRows(a.tables[0],U.defaults(a.tables[0]),'farm-a'),/Map the product/);
});

test('batch limit applies to input rows before deduplication',()=>{
  const a=analyze(JSON.stringify(Array.from({length:1001},()=>example)));
  assert.throws(()=>U.mappedRows(a.tables[0],U.defaults(a.tables[0]),'farm-a'),/at most 1,000/);
});

test('repository catalogue URLs cannot escape same-origin datasets',()=>{
  const origin='https://terraviva.example';
  for(const file of ['https://evil.test/a.csv','//evil.test/a.json','../api.csv','data/../../a.csv','%2e%2e/a.csv','foo%2f..%2fbar.csv','/datasets/a.csv','a.csv?token=1','a\\b.csv'])assert.throws(()=>U.safeDatasetURL(file,origin));
  assert.equal(U.safeDatasetURL('datasets/harvest.csv',origin).href,origin+'/datasets/harvest.csv');
  assert.equal(U.safeDatasetURL('harvest.json',origin).href,origin+'/datasets/harvest.json');
});

test('local-file decoding rejects invalid UTF-8 without replacement characters',async()=>{
  assert.equal(await U.readUTF8File(new Blob(['Peña'])),'Peña');
  const latin1=new Blob([Uint8Array.from([80,101,241,97])]);
  await assert.rejects(()=>U.readUTF8File(latin1),/not valid UTF-8/);
});

test('forcing a conflicting unit cannot erase a quantity unit declared in the source',()=>{
  const a=analyze('product,quantity,unit,field,date\nwheat,1250,kg,North,2026-10-16\n','test.csv');
  const mapping=U.defaults(a.tables[0]);mapping.unitMode='t';
  assert.throws(()=>U.mappedRows(a.tables[0],mapping,'farm-a'),/conflicts with that declaration/);
  mapping.unitMode='kg';
  assert.equal(I.prepare(U.mappedRows(a.tables[0],mapping,'farm-a'),context).totalTonnes,1.25);
});

test('a separate measure can use its own explicitly selected unit column',()=>{
  const a=analyze(JSON.stringify([{product:'wheat',quantity:1250,unit:'kg',dry_mass:1,dry_unit:'t',field:'North',date:'2026-10-16'}]));
  const table=a.tables[0],mapping=U.defaults(table);
  mapping.amount=String(table.columns.findIndex(c=>c.path[0]==='dry_mass'));
  mapping.unit=String(table.columns.findIndex(c=>c.path[0]==='dry_unit'));
  mapping.unitMode='column';
  assert.equal(I.prepare(U.mappedRows(table,mapping,'farm-a'),context).totalTonnes,1);
});

test('staged reference provenance preserves ancestor farm claims without assigning a farm',()=>{
  const reference={_terravivaDataset:{id:'table-1',role:'reference',farmerAssignment:null,source:{file:'archive.json',sha256:'test',tablePointer:'/harvests'},sourceContext:{'':{farm:'farm-b',title:'Synthetic reference'}}},records:[example]};
  const a=analyze(JSON.stringify(reference)),table=a.tables.find(t=>t.name==='records');
  assert.throws(()=>U.mappedRows(table,U.defaults(table),'farm-a',U.claimsIn(a.sourceData)),/does not match/);
  delete reference._terravivaDataset.sourceContext[''].farm;
  const b=analyze(JSON.stringify(reference)),t=b.tables.find(t=>t.name==='records');
  const mapped=U.mappedRows(t,U.defaults(t),'farm-a',U.claimsIn(b.sourceData));
  assert.equal(mapped[0].farm,undefined);
  assert.equal(reference._terravivaDataset.farmerAssignment,null);
  // A deliberate prepare/commit still requires a selected, explicit farm context.
  assert.equal(I.prepare(mapped,context).farm,'farm-a');
});

async function withImportView(manifest,run){
  const previousFetch=global.fetch,previousImport=global.TerraImport;
  class Container{
    set innerHTML(html){
      this.html=html;this.nodes=Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],{value:'',disabled:false}]));
      this.maps=[...html.matchAll(/data-import-map="([^"]+)"/g)].map(m=>({dataset:{importMap:m[1]},disabled:false}));
    }
    querySelector(selector){return this.nodes[selector.slice(1)]||null;}
    querySelectorAll(selector){return selector==='[data-import-map]'?this.maps:[...Object.values(this.nodes),...this.maps];}
  }
  try{
    global.fetch=async()=>({ok:true,json:async()=>manifest});global.TerraImport=I;
    const container=new Container(),snapshots=[];let busy=false,view;
    view=U.create({getContext:()=>({key:1,farm:'Demo farm',connected:false}),isBusy:()=>busy,setBusy:v=>{busy=v;},refresh:()=>view.render(container),
      getState(){throw Error('Source analysis must not request a harvest commit.');},updateState(){throw Error('Source analysis must not mutate the depot.');},
      status(){},analyseSource:source=>snapshots.push(source)});
    view.render(container);await new Promise(resolve=>setImmediate(resolve));
    await run({container,snapshots});
  }finally{global.fetch=previousFetch;if(previousImport===undefined)delete global.TerraImport;else global.TerraImport=previousImport;}
}

test('generic loaded sources can be analysed without harvest mapping and retain all original bytes',async()=>{
  await withImportView({status:'ready',datasets:[]},async({container,snapshots})=>{
    const source={_terravivaDataset:{role:'reference',farmerAssignment:null},records:[{country:'ES',production:10}]};
    const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify(source))]),blob=new Blob([bytes]);
    await container.querySelector('#import-file').onchange({target:{files:[{name:'reference.json',size:blob.size,arrayBuffer:()=>blob.arrayBuffer()}]}});
    assert.match(container.html,/Reference source · no farm has been assigned/);
    container.querySelector('#import-analyse-source').onclick();
    assert.equal(snapshots.length,1);assert.equal(snapshots[0].filename,'reference.json');
    assert.deepEqual(Buffer.from(snapshots[0].bytes),bytes);assert.equal(snapshots[0].farm,undefined);
    snapshots[0].bytes[0]=0;
    container.querySelector('#import-analyse-source').onclick();
    assert.equal(snapshots[1].bytes[0],0xef,'Passing a source cannot detach or mutate the retained source bytes.');
  });
});

test('empty catalogue distinguishes staged tables requiring splits from an absent archive',async()=>{
  await withImportView({status:'requires-split',datasets:[],unpublishedDatasets:[{id:'large'}]},async({container})=>{
    assert.match(container.html,/Source data has been staged/);assert.match(container.html,/1 table\(s\)/);
    assert.match(container.html,/0 available tables · 1 unpublished table/);
    assert.match(container.html,/large:<\/strong> This table requires splitting/);
    assert.doesNotMatch(container.html,/archive has not been added/);
  });
  await withImportView({status:'awaiting-source-archive',datasets:[]},async({container})=>{
    assert.match(container.html,/archive has not been added/);
    assert.match(container.html,/0 available tables · 0 unpublished tables/);
  });
});

test('mixed catalogue keeps unavailable table counts and escaped reasons visible',async()=>{
  const manifest={status:'ready',datasets:[{id:'ready',name:'Ready source',file:'ready.json',rows:10}],unpublishedDatasets:[
    {id:'large',name:'Regional totals',status:'requires-split',reason:'Full dataset view exceeds 1 MiB; split explicitly.'},
    {id:'wide',name:'<wide table>',status:'requires-split',reason:'Too many columns: <script>alert(1)</script>'}
  ]};
  await withImportView(manifest,async({container})=>{
    assert.match(container.html,/1 available table · 2 unpublished tables/);
    assert.ok(container.querySelector('#import-catalog'));
    assert.ok(container.querySelector('#import-load-source'));
    assert.match(container.html,/Ready source · 10 rows/);
    assert.match(container.html,/Regional totals:<\/strong> Full dataset view exceeds 1 MiB; split explicitly\./);
    assert.match(container.html,/&lt;wide table&gt;:<\/strong> Too many columns: &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(container.html,/<script>|archive has not been added/);
  });
});

test('catalogue reports zero unpublished tables when every source is available',async()=>{
  await withImportView({status:'ready',datasets:[{id:'a',name:'A',file:'a.json'},{id:'b',name:'B',file:'b.csv'}]},async({container})=>{
    assert.match(container.html,/2 available tables · 0 unpublished tables/);
    assert.doesNotMatch(container.html,/Why these tables are unavailable|archive has not been added/);
  });
});

test('an unpublished table without a reason is identified without inventing a cause',async()=>{
  await withImportView({status:'ready',datasets:[{id:'a',name:'A',file:'a.json'}],unpublishedDatasets:[{id:'unexplained'}]},async({container})=>{
    assert.match(container.html,/1 available table · 1 unpublished table/);
    assert.match(container.html,/unexplained:<\/strong> No publication reason was supplied in the catalogue\./);
  });
});

test('reference collection opens a separate all-row explorer without assigning its rows to the current farm',async()=>{
  await withImportView({status:'reference-ready',datasets:[],reference:{sourceFiles:28,rows:1754685,catalog:'/reference/index.json'}},async({container})=>{
    assert.match(container.html,/28 sources · 1,754,685 source-table rows/);
    assert.match(container.html,/href="\/reference-data\.html"/);
    assert.match(container.html,/collection remains unassigned/);
    assert.match(container.html,/counts do not represent distinct farms/);
    assert.doesNotMatch(container.html,/archive has not been added|id="import-load-source"|id="import-confirm"/);
    assert.ok(container.querySelector('#import-file'));
  });
});

test('untrusted reference manifest cannot inject a link or invented numeric counts',async()=>{
  await withImportView({status:'reference-ready',datasets:[],reference:{sourceFiles:'<script>',rows:1,href:'https://other.test'}},async({container})=>{
    assert.doesNotMatch(container.html,/<script>|https:\/\/other\.test|Hackathon reference collection/);
    assert.match(container.html,/hackathon collection is available in the reference explorer/);
  });
});
