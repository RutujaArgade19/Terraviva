'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const vm=require('node:vm');
const E=require('../public/eda-engine.js');
const A=require('../public/archive-profile.js');
const {validateArchive}=require('../scripts/report-archive.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Synthetic source observations exercise the real engine and strict report
// validator. They are not written to report/archive-analysis.json.
function reportFor(normalized,byteCount){
  const rows=normalized.tables.reduce((sum,table)=>sum+table.rowCount,0);
  return {schemaVersion:1,status:'complete',archive:{filename:'synthetic-adapter-test.zip',bytes:byteCount,sha256:'a'.repeat(64)},coverage:{fileCount:1,parsedFileCount:1,tableCount:normalized.tables.length,profiledTableCount:normalized.tables.length,totalTableRows:rows,profiledRows:rows,complete:true},files:[normalized.file],tables:normalized.tables,exclusions:[]};
}

test('real CSV engine profile normalizes into the exact complete-report schema with original byte provenance',()=>{
  const csv='sample,amount,weight,event_date\nA,1,2,2024-02-29\nB,2,4,2024-03-01\nC,,6,2024-03-01\n';
  const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(csv)]);
  const p=E.analyzeText(csv,{filename:'synthetic.csv'}),source={fileId:'source-a',path:'reference/synthetic.csv',sha256:hash(bytes),bytes:bytes.length};
  const normalized=A.normalizeProfile(p,source);
  assert.doesNotThrow(()=>validateArchive(reportFor(normalized,bytes.length)));
  assert.deepEqual(Object.keys(normalized),['file','tables']);
  assert.equal(normalized.file.sha256,hash(bytes));assert.equal(normalized.file.bytes,bytes.length);assert.equal(normalized.file.status,'profiled');
  assert.equal(normalized.tables[0].profiledRows,3);assert.equal(normalized.tables[0].role,'unknown');
  assert.equal(normalized.tables[0].columns.find(column=>column.name==='amount').unit,undefined);
  assert.match(normalized.tables[0].grain,/not established/);
  assert.match(normalized.file.notes.join('\n'),/maxRows=100000/);
  assert.match(normalized.file.notes.join('\n'),/R type 7/);
  assert.match(normalized.file.notes.join('\n'),/decoded|Decoded/);
  assert.deepEqual(normalized,A.normalizeProfile(p,source));
  assert.equal(p.tables[0].rows.length,3);
});

test('JSON table pointers are preserved while raw rows, farm metadata, examples and structured labels cannot pass through',()=>{
  const text=JSON.stringify({farm:'SYNTHETIC_PRIVATE_FARM',units:{amount:'tonnes'},'a/b':[{amount:1,detail:['SYNTHETIC_PRIVATE_CELL']},{amount:2,detail:['SYNTHETIC_PRIVATE_CELL']}]});
  const p=E.analyzeText(text,{filename:'synthetic.json'});
  p.extra={rows:['SYNTHETIC_PRIVATE_EXTRA']};p.tables[0].rawRows=['SYNTHETIC_PRIVATE_EXTRA'];
  p.tables[0].columns[0].examples=['SYNTHETIC_PRIVATE_EXTRA'];
  p.tables[0].columns[0].numeric.outlierRows=[{row:1,value:'SYNTHETIC_PRIVATE_EXTRA'}];
  const normalized=A.normalizeProfile(p,{fileId:'json-source',path:'nested/synthetic.json',sha256:hash(text),bytes:Buffer.byteLength(text)});
  assert.equal(normalized.tables[0].pointer,'/a~1b');
  const encoded=JSON.stringify(normalized);
  assert.doesNotMatch(encoded,/SYNTHETIC_PRIVATE/);
  assert.equal(normalized.tables[0].columns.find(column=>column.name==='detail').frequencies,undefined);
  assert.doesNotThrow(()=>validateArchive(reportFor(normalized,Buffer.byteLength(text))));
  assert.equal(p.sourceData.farm,'SYNTHETIC_PRIVATE_FARM');
  assert.equal(p.tables[0].rows[0].detail[0],'SYNTHETIC_PRIVATE_CELL');
});

test('diagnostic parser errors and explicit exclusions remain visible without copying error payloads',()=>{
  const csv='a,b\n1\n2,3,4';
  const p=E.analyzeText(csv,{filename:'synthetic-malformed.csv',delimiter:','});
  p.tables[0].rowErrors[0].rawRows=['SYNTHETIC_PRIVATE_ERROR'];
  p.exclusions=[{source:'synthetic-excluded.csv',reason:'Synthetic size boundary',rows:100,rawRows:['SYNTHETIC_PRIVATE_ERROR']}];
  const normalized=A.normalizeProfile(p,{fileId:'malformed',path:'synthetic-malformed.csv',sha256:hash(csv),bytes:Buffer.byteLength(csv)});
  assert.equal(normalized.file.status,'profiled');
  assert.ok(normalized.tables[0].issues.some(issue=>issue.severity==='error'&&/parser\/row-width/.test(issue.message)));
  assert.ok(normalized.tables[0].issues.some(issue=>/Profiler exclusion/.test(issue.message)));
  assert.match(normalized.file.notes.join('\n'),/Synthetic size boundary; 100 rows/);
  assert.doesNotMatch(JSON.stringify(normalized),/SYNTHETIC_PRIVATE_ERROR/);
});

test('adapter rejects sampled profiles and inconsistent provenance/counts and loads as a browser UMD',()=>{
  const csv='amount\n1\n2',source={fileId:'fixture',path:'synthetic.csv',sha256:hash(csv),bytes:Buffer.byteLength(csv)};
  const sampled=E.analyzeText(csv,{filename:'synthetic.csv'});sampled.source.sampled=true;
  assert.throws(()=>A.normalizeProfile(sampled,source),/unsampled/);
  const counts=E.analyzeText(csv,{filename:'synthetic.csv'});counts.tables[0].columns[0].missingCount=1;
  assert.throws(()=>A.normalizeProfile(counts,source),/do not reconcile/);
  const p=E.analyzeText(csv,{filename:'synthetic.csv'});
  assert.throws(()=>A.normalizeProfile(p,{...source,sha256:'incorrect'}),/SHA-256/);
  assert.throws(()=>A.normalizeProfile(p,{...source,bytes:1}),/exceeds/);
  const context={};context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/archive-profile.js'),'utf8'),context);
  assert.equal(typeof context.TerravivaArchiveProfile.normalizeProfile,'function');
});
