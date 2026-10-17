'use strict';
// Meaningful behavioural checks for data integrity, inference, and statistics.
const assert = require('node:assert/strict');
const E = require('../public/eda-engine.js');
let checks = 0;
function check(name, fn) { fn(); checks++; process.stdout.write('PASS ' + name + '\n'); }
function near(a, b, epsilon = 1e-10) { assert.ok(Math.abs(a - b) <= epsilon, a + ' differs from ' + b); }
function column(table, name) { return table.columns.find(c => c.path.join('.') === name); }

check('quoted CSV preserves delimiter, quotes, CRLF newline and BOM semantics', () => {
  const p = E.parseCSV('\ufeffid,note,quantity\r\n001,"wheat, ""north""\r\nfield",0\r\n002,"",12\r\n');
  assert.equal(p.delimiter, ',');
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].id, '001');
  assert.equal(p.rows[0].note, 'wheat, "north"\r\nfield');
  assert.equal(p.rows[0].quantity, '0');
  assert.deepEqual(p.rowErrors, []);
  assert.equal(p.rowLocations[1].line, 4);
});

check('semicolon and tab detection preserve locale decimal strings', () => {
  const t = E.analyzeText('id;quantity;crop\n001;12,5;wheat\n002;18,75;barley', {filename:'farm.csv'}).tables[0];
  assert.equal(t.delimiter, ';');
  assert.equal(t.rows[0].quantity, '12,5');
  assert.equal(column(t, 'quantity').numeric, null);
  assert.equal(column(t, 'quantity').unconvertedLocaleNumericCount, 2);
  const tab = E.parseCSV('id\tweight\n001\t12\n002\t15');
  assert.equal(tab.delimiter, '\t');
  assert.equal(tab.rows[1].weight, '15');
  assert.throws(() => E.parseCSV('a,b;c\n1,2;3'), e => e.code === 'ambiguous_delimiter');
});

check('short and long CSV rows retain extra values and locate errors', () => {
  const p = E.parseCSV('a,b\n1\n2,3,4', {delimiter:','});
  assert.equal(p.rows[0].b, undefined);
  assert.equal(p.rows[1]['Extra field 1'], '4');
  assert.deepEqual(p.rowErrors.map(e => e.row), [1,2]);
  assert.equal(p.rowErrors[0].expected, 2);
  assert.equal(p.rowErrors[1].actual, 3);
  assert.equal(E.parseCSV('a,b\n1,"unterminated', {delimiter:','}).rowErrors[0].code, 'csv_unclosed_quote');
});

check('duplicate and unsafe headers cannot overwrite data', () => {
  const p = E.parseCSV('id,id,id [2],__proto__,\n1,2,3,4,5');
  assert.equal(new Set(p.headers).size, 5);
  assert.deepEqual(Object.values(p.rows[0]), ['1','2','3','4','5']);
  assert.equal(p.rows[0].__proto__, '4');
  assert.equal({}.polluted, undefined);
});

check('zero, false and NA are not missing and all rows drive inference', () => {
  const rows = [{v:0,b:false,l:'NA'},{v:2,b:true,l:''},{v:null,b:null,l:'  '},{b:false,l:'NA'}];
  const t = E.profileTable(rows);
  assert.equal(column(t,'v').missingCount, 2);
  assert.equal(column(t,'v').numeric.mean, 1);
  assert.equal(column(t,'b').missingCount, 1);
  assert.equal(column(t,'b').type, 'boolean');
  assert.equal(column(t,'l').missingCount, 2);
  assert.equal(column(t,'l').uniqueCount, 1);
  assert.equal(t.rows[0], rows[0]);
  const many = Array.from({length:1000}, () => ({quantity:'12'}));
  many.push({quantity:'not numeric'});
  const c = column(E.profileTable(many),'quantity');
  assert.equal(c.type, 'categorical');
  assert.equal(c.numericCandidateCount, 1000);
  assert.equal(c.numeric, null);
  assert.equal(c.inferenceRows, 1001);
});

check('IDs, postal codes, phone numbers and years are excluded from measures', () => {
  const t = E.profileTable([
    {farmerId:1,postcode:'28001',phone:'+34612345678',year:2025,quantity:2025},
    {farmerId:2,postcode:'08001',phone:'+34612345679',year:2026,quantity:2026}
  ]);
  ['farmerId','postcode','phone','year'].forEach(name => assert.equal(column(t,name).type,'identifier'));
  assert.equal(column(t,'quantity').type,'numeric');
  assert.equal(t.numericPairs.length,0);
});

check('numeric summaries use sample SD, type-7 quantiles and 1.5-IQR flags', () => {
  const c = column(E.profileTable([1,2,3,4,100].map(quantity => ({quantity}))), 'quantity');
  near(c.numeric.mean,22);
  near(c.numeric.median,3);
  near(c.numeric.p25,2);
  near(c.numeric.p75,4);
  near(c.numeric.sampleSd,Math.sqrt(1902.5));
  near(c.numeric.lowerFence,-1);
  near(c.numeric.upperFence,7);
  assert.deepEqual(c.numeric.outlierRows,[{row:5,value:100}]);
  assert.equal(c.numeric.histogram.bins.reduce((s,b)=>s+b.count,0),5);
  const one = column(E.profileTable([{quantity:0}]),'quantity');
  assert.equal(one.numeric.sampleSd,null);
  assert.equal(one.numeric.mean,0);
});

check('pairwise-complete correlations disclose overlap and constant pairs', () => {
  const t = E.profileTable([
    {quantity:1,weight:2,constant:5,sparse:8},
    {quantity:2,weight:null,constant:5,sparse:null},
    {quantity:3,weight:6,constant:5,sparse:null},
    {quantity:null,weight:9,constant:5,sparse:10}
  ]);
  const p = t.numericPairs.find(p=>p.x==='/quantity'&&p.y==='/weight');
  assert.equal(p.n,2); near(p.r,1); assert.equal(p.smallSample,true);
  assert.equal(t.numericPairs.find(p=>p.x==='/quantity'&&p.y==='/constant').status,'zero_variance');
  assert.equal(t.numericPairs.find(p=>p.x==='/quantity'&&p.y==='/sparse').status,'insufficient_pairs');
});

check('dates reject invalid and ambiguous values; explicit DMY is optional', () => {
  assert.equal(E.dateValue('2026-02-30'),null);
  assert.equal(E.dateValue('2025-02-29'),null);
  assert.equal(E.dateValue('2024-02-29').format,'YYYY-MM-DD');
  assert.equal(E.dateValue('01/02/2026'),null);
  assert.equal(E.dateValue('01/02/2026','DMY').timestamp,Date.parse('2026-02-01T00:00:00Z'));
  assert.equal(E.dateValue(2026),null);
  assert.equal(E.dateValue('2026-01-01T25:00:00Z'),null);
  const t = E.profileTable([{date:'2026-10-01'},{date:'2026-10-03'},{date:'2026-10-03'}]);
  const d = column(t,'date').dates;
  assert.equal(d.distinctDays,2); assert.equal(d.calendarDays,3); assert.equal(d.daysWithoutRecords,1);
  const naive = column(E.profileTable([{date:'2026-10-03T12:15:00'}]),'date');
  assert.equal(naive.dates.timezoneNaiveCount,1);
});

check('JSON nested structures preserve record and envelope provenance', () => {
  const result = E.analyzeText('{"farm":"north","depot":{"records":[{"id":"x","farm":{"name":"A"},"farm.name":"B","tags":["a","b"]}],"grants":[]},"metadata":{"description":"example"}}',{filename:'depot.json'});
  assert.equal(result.tables.length,2);
  const t=result.tables[0];
  assert.deepEqual(t.path,['depot','records']);
  assert.equal(result.sourceData.farm,'north');
  assert.equal(t.rows[0].farm.name,'A');
  assert.equal(t.flatRows[0]['/farm/name'],'A');
  assert.equal(t.flatRows[0]['/farm.name'],'B');
  assert.equal(E.getPath(t.rows[0],['farm','name']),'A');
  assert.equal(E.getPath(t.rows[0],'/farm/name'),'A');
  assert.equal(column(t,'tags').type,'structured');
});

check('duplicates ignore object key order but preserve types, array order and absent keys', () => {
  const t = E.profileTable([
    {a:1,b:{x:2,y:3},c:['u','v']},
    {c:['u','v'],b:{y:3,x:2},a:1},
    {a:'1',b:{x:2,y:3},c:['u','v']},
    {a:1,b:{x:2,y:3},c:['v','u']},
    {a:null},{}
  ]);
  assert.equal(t.duplicateCount,1);
  assert.deepEqual(t.duplicateGroups[0].rows,[1,2]);
  assert.equal(t.duplicateParticipantCount,2);
});

check('JSON rejects duplicate keys and preserves unsafe integers without rounding', () => {
  assert.throws(()=>E.parseJSON('[{"id":"a","id":"b"}]'),e=>e.code==='duplicate_json_key');
  const r=E.analyzeText('[{"id":9007199254740993,"quantity":1.25,"huge":1e400}]',{filename:'exact.json'});
  assert.equal(r.tables[0].rows[0].id,'9007199254740993');
  assert.equal(r.tables[0].rows[0].quantity,1.25);
  assert.equal(r.tables[0].rows[0].huge,'1e400');
  assert.ok(r.issues.some(i=>i.code==='unsafe_integer_preserved'));
  assert.throws(()=>E.parseJSON('{"a":1,}'),e=>e.code==='invalid_json');
  assert.throws(()=>E.parseJSON('[1,]'),e=>e.code==='invalid_json');
});

check('JSON scientific IDs, underflow and high precision keep exact source text', () => {
  const r = E.analyzeText('[{"id":9.007199254740993e15,"tiny":1e-400,"precise":0.1234567890123456789,"ordinary":1.2300e2}]', {filename:'precision.json'});
  const row = r.tables[0].rows[0];
  assert.equal(row.id, '9.007199254740993e15');
  assert.equal(row.tiny, '1e-400');
  assert.equal(row.precise, '0.1234567890123456789');
  assert.equal(row.ordinary, 123);
  assert.ok(r.issues.some(i => i.code === 'unsafe_integer_preserved'));
  assert.equal(r.issues.find(i => i.code === 'numeric_precision_preserved').count, 2);
});

check('limits reject inputs instead of silently truncating or sampling', () => {
  assert.throws(()=>E.profileTable(new Array(E.limits.maxRows+1).fill({quantity:1})),e=>e.code==='row_limit');
  assert.throws(()=>E.analyzeText('a\n1',{sizeBytes:E.limits.maxFileBytes+1}),e=>e.code==='file_limit');
  const wide={}; for(let i=0;i<E.limits.maxColumns+1;i++) wide['c'+i]=i;
  assert.throws(()=>E.profileTable([wide]),e=>e.code==='column_limit');
});

process.stdout.write('\n'+checks+' behavioural checks passed.\n');
