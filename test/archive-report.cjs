'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {applyArchive,validateArchive}=require('../scripts/report-archive.cjs');
const template=fs.readFileSync(path.join(__dirname,'../report/template.html'),'utf8');

// All fixture statistics are invented for isolated renderer tests. They are
// never written to report/archive-analysis.json or used as source observations.
function fixture(){return {
  schemaVersion:1,status:'partial',generatedAt:'2026-10-17T00:00:00Z',title:'Synthetic fixture report',
  archive:{filename:'synthetic-fixture.zip',bytes:1024,sha256:'a'.repeat(64)},
  coverage:{fileCount:2,parsedFileCount:1,tableCount:2,profiledTableCount:2,totalTableRows:7,profiledRows:3,complete:false,notes:['Synthetic fixture: partial scope.']},
  files:[{id:'source',path:'synthetic-source.csv',format:'csv',bytes:42,sha256:'b'.repeat(64),status:'profiled'}],
  tables:[
    {id:'measure',name:'Synthetic reference observations',fileId:'source',grain:'One invented region-year observation.',role:'reference',rowCount:6,profiledRows:2,columnCount:1,duplicateCount:0,columns:[{name:'mass',type:'numeric',unit:'tonnes',nonMissingCount:2,missingCount:0,uniqueCount:2,numeric:{n:2,mean:2,median:2,p25:1.5,p75:2.5,min:1,max:3,sampleSd:Math.sqrt(2),outlierCount:0,histogram:{method:'Synthetic fixed bins',bins:[{low:1,high:2,count:1},{low:2,high:3,count:1}]}}}]},
    {id:'labels',name:'Synthetic lookup',fileId:'source',grain:'One invented label.',rowCount:1,profiledRows:1,columnCount:1,duplicateCount:null,columns:[{name:'label',type:'categorical',nonMissingCount:1,missingCount:0,uniqueCount:1,frequencies:[{label:'<script>example</script>',count:1}]}]}
  ],
  findings:[{title:'Synthetic finding only',body:'Not an observed archive result.',evidence:[{tableId:'measure',column:'mass',text:'Two synthetic values.'}]}],
  exclusions:[{source:'unreadable.bin',reason:'Synthetic parser exclusion.',rows:null}],
  staging:{status:'requires-split',publishedTables:0,unpublishedTables:2},methods:{version:'synthetic-test',notes:['Test fixture only.']}
};}

test('absent archive preserves waiting state and original pinned audit',()=>{
  const result=applyArchive(template,null);
  assert.equal(result.archiveJSON,'null');
  assert.match(result.html,/The source archive has not been loaded/);
  assert.match(result.html,/e0013fbfb8c9de2d5a7b850216270e6836857073/);
  assert.doesNotMatch(result.html,/__ARCHIVE_(?:SECTIONS|EVIDENCE)__/);
  assert.doesNotMatch(result.html,/id="archive-profiles"/);
});

test('archive profiles are permanent complete markup with separate table grains and measured coverage',()=>{
  const {html,archiveJSON}=applyArchive(template,fixture());
  assert.ok(html.indexOf('id="archive-profiles"')<html.indexOf('id="analysis"'));
  assert.ok(html.indexOf('id="analysis"')<html.indexOf('id="anatomy"'));
  assert.match(html,/id="archive-table-0"/);assert.match(html,/id="archive-table-1"/);
  assert.match(html,/id="scope-kpi">3<\/strong>/);
  assert.match(html,/One invented region-year observation/);assert.match(html,/One invented label/);
  assert.match(html,/partial or not fully quantified/);
  assert.match(html,/requires split/);assert.match(html,/unreadable\.bin/);
  assert.match(html,/Reference · unassigned/);
  assert.match(html,/Original app architecture/);
  assert.match(html,/original ZIP bytes/);
  assert.match(html,/e0013fbfb8c9de2d5a7b850216270e6836857073/);
  assert.doesNotMatch(html,/The source archive has not been loaded|Archive transfer pending|The current catalog is explicitly empty|Source bytes not available in this report version/);
  assert.match(html,/A documented analysis of/);assert.doesNotMatch(html,/A full reading of/);
  assert.equal(JSON.parse(archiveJSON).tables.length,2);
});

test('all source strings and embedded JSON are escaped; unknown counts remain undefined',()=>{
  const data=fixture();data.archive.filename='synthetic-$&-</script><script>alert(1)</script>.zip';
  data.findings[0].title='<img src=x onerror=alert(1)>';
  const {html,archiveJSON}=applyArchive(template,data);
  assert.doesNotMatch(html,/<img src=x|<script>alert\(1\)<\/script>/);
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html,/&lt;script&gt;example&lt;\/script&gt;/);
  assert.match(html,/A documented analysis of synthetic-\$&amp;-/);
  assert.doesNotMatch(archiveJSON,/</);
  assert.equal(JSON.parse(archiveJSON).archive.filename,data.archive.filename);
  const lookup=html.slice(html.indexOf('id="archive-table-1"'));
  assert.match(lookup,/EXACT REPEATS<\/p><strong>—<\/strong>/);
});

test('unequal numeric intervals are labeled counts, without a false uniform numeric axis',()=>{
  const data=fixture();data.tables[0].columns[0].numeric.histogram.bins=[{low:1,high:2,count:1},{low:2,high:10,count:1}];
  const {html}=applyArchive(template,data);
  assert.match(html,/INTERVAL COUNTS/);
  assert.match(html,/rather than a uniform-axis histogram/);
});

test('inconsistent profiles, unsupported evidence and raw rows fail before publication',()=>{
  const data=fixture();data.archive.sha256='not a checksum';assert.throws(()=>validateArchive(data),/SHA-256/);
  const counts=fixture();counts.tables[0].columns[0].missingCount=1;assert.throws(()=>validateArchive(counts),/do not reconcile/);
  const refs=fixture();refs.findings[0].evidence[0].tableId='absent';assert.throws(()=>validateArchive(refs),/unknown table/);
  const raw=fixture();raw.tables[0].rows=[{secret:'synthetic'}];assert.throws(()=>validateArchive(raw),/Unknown archive analysis field/);
  const categories=fixture();categories.tables[1].columns[0].frequencies[0].count=2;assert.throws(()=>validateArchive(categories),/Category counts exceed/);
});

test('recursive allowlist rejects raw or unknown payloads at every nesting level',()=>{
  const mutators=[
    data=>data.rows=[{privateRow:'SYNTHETIC_SENTINEL'}],
    data=>data.sourceData={privateRow:'SYNTHETIC_SENTINEL'},
    data=>data.files[0].records=[{privateRow:'SYNTHETIC_SENTINEL'}],
    data=>data.tables[0].extra={rawRows:[{privateRow:'SYNTHETIC_SENTINEL'}]},
    data=>data.tables[0].columns[0].numeric.histogram.rawRows=[{privateRow:'SYNTHETIC_SENTINEL'}],
    data=>data.tables[0].columns[0].numeric.histogram.bins[0].records=[{privateRow:'SYNTHETIC_SENTINEL'}],
    data=>data.methods.notes=[{privateRow:'SYNTHETIC_SENTINEL'}],
    data=>data.findings[0].evidence[0].text={privateRow:'SYNTHETIC_SENTINEL'},
    data=>data.exclusions[0].rows=[{privateRow:'SYNTHETIC_SENTINEL'}]
  ];
  for(const mutate of mutators){const data=fixture();mutate(data);assert.throws(()=>applyArchive(template,data),/Unknown archive analysis field|must be plain text|must be a non-negative safe integer/);}
  const clean=fixture(),normalized=validateArchive(clean);
  assert.deepEqual(normalized,clean);
  assert.notEqual(normalized,clean);assert.notEqual(normalized.tables,clean.tables);assert.notEqual(normalized.tables[0].columns[0].numeric,clean.tables[0].columns[0].numeric);
  clean.methods.notes.push('SYNTHETIC_SENTINEL');assert.equal(normalized.methods.notes.includes('SYNTHETIC_SENTINEL'),false);
});

test('declared coverage reconciles with listed inventory and supplied profiles',()=>{
  const mutators=[
    data=>data.coverage.profiledRows=8,
    data=>data.coverage.parsedFileCount=3,
    data=>data.coverage.profiledTableCount=3,
    data=>data.coverage.profiledTableCount=1,
    data=>data.coverage.profiledRows=4,
    data=>data.coverage.totalTableRows=6,
    data=>data.coverage.totalTableRows=8,
    data=>data.coverage.fileCount=0,
    data=>data.coverage.complete='false',
    data=>data.coverage.complete=null,
    data=>data.coverage.complete=true,
    data=>data.status='complete'
  ];
  for(const mutate of mutators){const data=fixture();mutate(data);assert.throws(()=>validateArchive(data),/exceeds|reconcile|smaller|boolean|must agree/);}
});

test('complete status requires all inventoried sources, rows and fields and no exclusions',()=>{
  const complete=fixture();complete.status='complete';complete.coverage={fileCount:1,parsedFileCount:1,tableCount:2,profiledTableCount:2,totalTableRows:3,profiledRows:3,complete:true};complete.tables[0].rowCount=2;complete.exclusions=[];
  const {html}=applyArchive(template,complete);
  assert.match(html,/Inventoried sources fully covered/);
  assert.match(html,/Complete coverage of inventoried sources, with no exclusions/);
  for(const mutate of [data=>delete data.coverage.profiledRows,data=>data.exclusions=[{source:'synthetic-unused.csv',reason:'Excluded in fixture'}],data=>data.tables[0].columnCount=2,data=>data.tables[0].columns[0].missingCount=null,data=>data.coverage.fileCount=2,data=>data.tables[0].profiledRows=null]){
    const data=structuredClone(complete);mutate(data);assert.throws(()=>validateArchive(data),/Complete|excluded|reconcile|represented/);
  }
});

test('numeric population counts, Pearson bounds and calendar buckets cannot overstate valid data',()=>{
  const invalid=[
    data=>data.tables[0].columns[0].numeric.n=-1,
    data=>data.tables[0].columns[0].numeric.n=3,
    data=>data.tables[0].columns[0].numeric.outlierCount=3,
    data=>data.tables[0].columns[0].numeric.histogram.bins[0].count=1.5,
    data=>data.tables[0].columns[0].numeric.histogram.bins[0].count=3,
    data=>data.tables[0].numericPairs=[{xName:'mass',yName:'other',n:2,r:2}],
    data=>data.tables[0].numericPairs=[{xName:'mass',yName:'other',n:3,r:.5}],
    data=>data.tables[0].columns[0].dates={dayCounts:[{date:'2026-02-30',count:1}]},
    data=>data.tables[0].columns[0].dates={monthCounts:[{month:'2026-99',count:1}]}
  ];
  for(const mutate of invalid){const data=fixture();mutate(data);assert.throws(()=>validateArchive(data),/integer|exceeds|Pearson|calendar/);}
  const leap=fixture();leap.tables[0].columns[0].dates={dayCounts:[{date:'2024-02-29',count:2}]};assert.doesNotThrow(()=>validateArchive(leap));
});

function collectionFixture(){
  const data=fixture();
  data.archive={kind:'source-collection',filename:'synthetic-extracted-folder',originalArchiveFilename:'unretrieved-synthetic.zip',inventoryBasis:'Invented partial folder listing for isolated tests.',inventoryComplete:false};
  data.coverage={...data.coverage,fileCount:null,tableCount:null,totalTableRows:null,retrievedFileCount:1,unretrievedFileCount:null,retrievedBytes:42};
  data.files[0].retrievalStatus='retrieved';
  data.files.push({id:'unretrieved',path:'synthetic-unretrieved.csv',retrievalStatus:'not-retrieved',status:'not-retrieved'});
  return data;
}

test('source collections show measured retrieval while leaving unknown release scope explicit',()=>{
  const {html,archiveJSON}=applyArchive(template,collectionFixture());
  assert.match(html,/RETRIEVED SOURCE FILES<\/p><strong>1<\/strong>/);
  assert.match(html,/TABLE PROFILES<\/p><strong>2<\/strong>/);
  assert.match(html,/Full-release file count not established/);
  assert.match(html,/Full-release table coverage not established/);
  assert.match(html,/Original ZIP provenance is not claimed/);
  assert.match(html,/Original source-file checksums \(1\)/);
  assert.match(html,/Listing size only; bytes not retrieved/);
  assert.match(html,/archive-evidence-banner is-partial/);
  assert.doesNotMatch(html,/Hash of original ZIP bytes/);
  assert.equal(JSON.parse(archiveJSON).coverage.fileCount,null);
});

test('collection provenance rejects invented ZIP evidence, unretrieved measurements and inconsistent totals',()=>{
  const invalid=[
    data=>data.archive.sha256='c'.repeat(64),
    data=>data.archive.bytes=0,
    data=>delete data.archive.inventoryBasis,
    data=>data.coverage.retrievedBytes=43,
    data=>data.coverage.retrievedFileCount=2,
    data=>data.coverage.parsedFileCount=2,
    data=>delete data.files[0].sha256,
    data=>data.files[1].bytes=12,
    data=>data.tables[0].fileId='unretrieved',
    data=>{data.status='complete';data.coverage.complete=true;},
    data=>data.archive.inventoryComplete=true
  ];
  for(const mutate of invalid){const data=collectionFixture();mutate(data);assert.throws(()=>validateArchive(data),/ZIP|inventory|reconcile|exceeds|byte count|Retrieved|Unretrieved|retrieved file/);}
});
