'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {applyArchive}=require('../scripts/report-archive.cjs');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');

test('the delivered report preserves the measured source collection and complete retrieved profiles',()=>{
  const analysis=JSON.parse(read('report/archive-analysis.json'));
  const {html,archiveJSON}=applyArchive(read('report/template.html'),analysis);
  assert.equal(analysis.status,'partial');
  assert.equal(analysis.coverage.complete,false);
  assert.equal(analysis.coverage.retrievedFileCount,28);
  assert.equal(analysis.coverage.retrievedBytes,566600488);
  assert.equal(analysis.coverage.profiledRows,1754685);
  assert.equal(analysis.tables.length,28);
  assert.equal(analysis.tables.reduce((sum,t)=>sum+t.columnCount,0),804);
  assert.equal(analysis.findings.length,24);
  assert.equal(analysis.relationships.length,19);
  assert.equal(analysis.staging.publishedTables,28);
  assert.equal(analysis.staging.unpublishedTables,0);
  for(const table of analysis.tables){assert.equal(table.rowCount,table.profiledRows);assert.equal(table.columns.length,table.columnCount);}
  const farm=analysis.tables.find(t=>t.id==='combined_challenge1_farm_reporting_ready');
  const sale=analysis.tables.find(t=>t.id==='combined_challenge3_sales_certification_ready');
  assert.equal(farm.rowCount,200000);assert.equal(farm.columnCount,77);
  assert.equal(sale.rowCount,354614);assert.equal(sale.columnCount,26);
  assert.deepEqual(JSON.parse(archiveJSON),analysis);
  assert.match(html,/RETRIEVED SOURCE FILES<\/p><strong>28<\/strong>/);
  assert.match(html,/id="scope-kpi">1,754,685<\/strong>/);
  assert.doesNotMatch(html,/The source archive has not been loaded|Archive transfer pending/);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length,'Report anchors must remain unique');
  for(const [,target] of html.matchAll(/\bhref="#([^"]+)"/g))assert.ok(ids.includes(target),'Unresolved report anchor: '+target);
});

test('the committed report is self-contained and its inline blocks match the deployment CSP',()=>{
  const html=read('public/data-report.html');
  assert.doesNotMatch(html,/<script\b[^>]*\bsrc=/i);
  assert.doesNotMatch(html,/<link\b[^>]*\brel=["']stylesheet/i);
  assert.doesNotMatch(html,/__(?:REPORT_CSS|ARCHIVE_ANALYSIS|ARCHIVE_SECTIONS|ARCHIVE_EVIDENCE|INITIAL_DATASET|EDA_ENGINE|REPORT_UI)__/);
  const csp=JSON.parse(read('vercel.json')).headers.flatMap(rule=>rule.headers).find(header=>header.key.toLowerCase()==='content-security-policy').value;
  for(const [,body] of html.matchAll(/<(?:script|style)(?:\s[^>]*)?>([\s\S]*?)<\/(?:script|style)>/g)){
    const hash="'sha256-"+crypto.createHash('sha256').update(body).digest('base64')+"'";
    assert.ok(csp.includes(hash),'Exact inline content must be authorized by its hash');
  }
  assert.ok(!csp.includes("'unsafe-inline'"));
});
