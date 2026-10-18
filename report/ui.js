(function(){
'use strict';
const E=window.TerravivaEDA,$=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(v,d=2)=>v===null||v===undefined||!Number.isFinite(v)?'—':new Intl.NumberFormat('en-GB',{maximumFractionDigits:d}).format(v);
const pct=(a,b)=>b?fmt(a/b*100,1)+'%':'—';
const pretty=v=>v===undefined?'(absent)':v===null?'null':typeof v==='object'?JSON.stringify(v):String(v);
const labels={numeric:'Numeric measure',date:'Date / time',categorical:'Category',text:'Text',identifier:'Identifier',boolean:'Boolean',structured:'Structured',mixed:'Mixed',empty:'Empty'};
const colors={numeric:'#567f5c',date:'#91a6a0',categorical:'#b5c878',text:'#d9c69b',identifier:'#71847c',boolean:'#a9b696',structured:'#b49c83',mixed:'#d0a584',empty:'#d8ddcd'};
// The source archive is permanent report evidence. An uploaded file is a
// separate, replaceable analysis and must never rewrite that evidence.
const archiveContext=(()=>{try{const value=JSON.parse($('archive-analysis')?.textContent||'null');return value?.schemaVersion===1&&value?.archive?.filename?value:null}catch{return null}})();
let current=null,currentKind='',selected=0,checksum=null,loadedAt=null,loadToken=0;
const sourceText='The audited repository contains application code and tests, but no farm dataset archive. The figures below describe the implementation. Farm-level statistics remain unmeasured until a data file is supplied.';
function status(text,error=false){$('analysis-status').textContent=text;$('analysis-status').classList.toggle('error',error)}
function currentTable(){return current?.tables[selected]||null}
function empty(message){return '<div class="no-data">'+esc(message)+'</div>'}
function svg(content,label,w=420,h=245){return '<svg class="chart-svg" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="'+esc(label)+'"><title>'+esc(label)+'</title>'+content+'</svg>'}
function setOptions(id,columns,previous){const select=$(id);select.innerHTML=columns.map(c=>'<option value="'+esc(c.key)+'">'+esc(c.name)+'</option>').join('');if(previous&&columns.some(c=>c.key===previous))select.value=previous;select.disabled=!columns.length}
function selectedColumn(id){return currentTable()?.columns.find(c=>c.key===$(id).value)}
function barChart(rows,denominator,label,color='#718b51'){
 if(!rows.length||!denominator)return empty('No non-missing values to plot.');
 const w=460,left=132,right=57,top=11,gap=29,h=top+rows.length*gap+13;
 let body='';
 rows.forEach((r,i)=>{const y=top+i*gap,barW=Math.max(0,(w-left-right)*r.count/denominator),full=String(r.label),short=full.length>20?full.slice(0,19)+'…':full;
 body+='<text x="0" y="'+(y+11)+'"><title>'+esc(full)+'</title>'+esc(short)+'</text><rect x="'+left+'" y="'+y+'" width="'+(w-left-right)+'" height="14" rx="3" fill="#ebeedf"/><rect x="'+left+'" y="'+y+'" width="'+barW+'" height="14" rx="3" fill="'+color+'"><title>'+esc(full)+': '+fmt(r.count,0)+' ('+pct(r.count,denominator)+')</title></rect><text x="'+(w-2)+'" y="'+(y+11)+'" text-anchor="end">'+(r.display||fmt(r.count,0))+'</text>';
 });
 return svg(body,label,w,h);
}
function renderMissingness(t){
 const cols=[...t.columns].sort((a,b)=>b.missingCount-a.missingCount);
 const show=cols.slice(0,20);
 $('missingness-chart').innerHTML=t.rowCount?barChart(show.map(c=>({label:c.name,count:c.nonMissingCount,display:pct(c.nonMissingCount,t.rowCount)})),t.rowCount,'Present values by column')+(cols.length>20?'<p class="caption">Showing 20 of '+cols.length+' fields, starting with the most missing values. Every field is listed below.</p>':''):empty('No observations. Completeness is undefined.');
}
function renderTypes(t){
 const counts={};t.columns.forEach(c=>counts[c.type]=(counts[c.type]||0)+1);
 if(!t.columnCount){$('type-chart').innerHTML=empty('No fields are available.');return}
 let x=0;let body='';const width=450;
 Object.entries(counts).forEach(([type,count])=>{const size=width*count/t.columnCount;body+='<rect x="'+x+'" y="0" width="'+Math.max(0,size-2)+'" height="24" rx="3" fill="'+(colors[type]||'#a9b696')+'"><title>'+esc(labels[type]||type)+': '+count+'</title></rect>';x+=size});
 $('type-chart').innerHTML=svg(body,'Column counts by inferred semantic type',450,32)+'<div class="type-legend">'+Object.entries(counts).map(([type,count])=>'<div class="type-row"><span class="type-name">'+esc(labels[type]||type)+'</span><strong>'+count+' <span class="caption">'+pct(count,t.columnCount)+'</span></strong></div>').join('')+'</div>';
}
function renderColumns(){
 const t=currentTable();if(!t)return;
 const query=$('column-search').value.trim().toLowerCase();
 const cols=t.columns.filter(c=>(c.name+' '+c.type).toLowerCase().includes(query));
 $('column-table').innerHTML='<table><thead><tr><th>Field</th><th>Type</th><th>Present</th><th>Missing</th><th>Distinct</th><th>Mean / typical</th><th>Range / coverage</th></tr></thead><tbody>'+cols.map(c=>{
 const central=c.numeric?fmt(c.numeric.mean):c.dates?c.dates.distinctDays+' observed days':c.frequencies?.length?c.frequencies[0].label:'—';
 const range=c.numeric?fmt(c.numeric.min)+' → '+fmt(c.numeric.max):c.dates?c.dates.min.slice(0,10)+' → '+c.dates.max.slice(0,10):c.constant?'Constant':c.uniqueCount+' distinct values';
 return '<tr><td><code>'+esc(c.name)+'</code><small>'+esc(c.key)+'</small></td><td title="'+esc(c.inference)+'">'+esc(labels[c.type]||c.type)+'</td><td class="numeric">'+fmt(c.nonMissingCount,0)+'</td><td class="numeric">'+fmt(c.missingCount,0)+'<small>'+pct(c.missingCount,t.rowCount)+'</small></td><td class="numeric">'+fmt(c.uniqueCount,0)+'</td><td>'+esc(String(central).slice(0,120))+'</td><td>'+esc(range)+'</td></tr>';
 }).join('')+'</tbody></table>'+(cols.length?'':'<p class="caption">No fields match this filter.</p>');
}
function renderNumeric(){
 const c=selectedColumn('numeric-select');
 if(!c?.numeric){$('numeric-chart').innerHTML=empty('No continuous numeric measure was identified.');$('numeric-summary').innerHTML='';return}
 const n=c.numeric,bins=n.histogram.bins,w=460,h=240,L=45,R=12,T=24,B=45,innerW=w-L-R,innerH=h-T-B,max=Math.max(1,...bins.map(b=>b.count));let body='';
 for(let k=0;k<=4;k++){const y=T+innerH-innerH*k/4;body+='<line class="grid" x1="'+L+'" x2="'+(w-R)+'" y1="'+y+'" y2="'+y+'"/><text x="'+(L-8)+'" y="'+(y+3)+'" text-anchor="end">'+fmt(max*k/4,1)+'</text>'}
 bins.forEach((b,i)=>{const bw=innerW/bins.length,barH=innerH*b.count/max;body+='<rect class="hist-bar" x="'+(L+i*bw+2)+'" y="'+(T+innerH-barH)+'" width="'+Math.max(1,bw-4)+'" height="'+barH+'" rx="2"><title>'+fmt(b.low,6)+' to '+fmt(b.high,6)+': '+b.count+'</title></rect>'});
 body+='<line class="axis" x1="'+L+'" x2="'+(w-R)+'" y1="'+(T+innerH)+'" y2="'+(T+innerH)+'"/><text x="'+L+'" y="'+(h-22)+'">'+fmt(n.min,4)+'</text><text x="'+(w-R)+'" y="'+(h-22)+'" text-anchor="end">'+fmt(n.max,4)+'</text><text x="'+L+'" y="11">COUNT</text>';
 $('numeric-chart').innerHTML=svg(body,'Histogram of '+c.name+'; n = '+n.n,w,h);
 if(n.max!==n.min){const scale=v=>25+(v-n.min)/(n.max-n.min)*410;const y=26;let box='<line class="axis" x1="25" x2="435" y1="'+y+'" y2="'+y+'"/><line class="median" x1="25" x2="25" y1="15" y2="37"/><line class="median" x1="435" x2="435" y1="15" y2="37"/><rect class="box" x="'+scale(n.p25)+'" y="10" width="'+Math.max(1,scale(n.p75)-scale(n.p25))+'" height="32"/><line class="median" x1="'+scale(n.median)+'" x2="'+scale(n.median)+'" y1="10" y2="42"/><text x="25" y="59">MIN</text><text x="435" y="59" text-anchor="end">MAX</text>';$('numeric-chart').innerHTML+=svg(box,'Quartile strip: min, Q1, median, Q3 and max. Endpoints are the observed minimum and maximum, not Tukey whiskers.',460,70)}
 const metrics=[['Valid n',n.n],['Mean',n.mean],['Median',n.median],['Q1',n.p25],['Q3',n.p75],['Sample SD',n.sampleSd],['Minimum',n.min],['Maximum',n.max],['IQR flags',n.outlierCount]];
 $('numeric-summary').innerHTML='<div class="summary-grid">'+metrics.map(([label,v])=>'<div><span>'+label+'</span><strong>'+fmt(v,4)+'</strong></div>').join('')+'</div><p class="caption">'+esc(n.histogram.method)+'. Quartile-strip endpoints are the observed minimum and maximum.</p>';
}
function renderCategory(){
 const c=selectedColumn('category-select');if(!c){$('category-chart').innerHTML=empty('No categorical or text column is available.');return}
 const top=(c.frequencies||[]).slice(0,10).map(r=>({label:r.label,count:r.count}));
 const rest=c.nonMissingCount-top.reduce((s,r)=>s+r.count,0);if(rest>0)top.push({label:'Other values (combined)',count:rest});
 $('category-chart').innerHTML=barChart(top,c.nonMissingCount,'Value frequencies of '+c.name,'#a8bc69')+'<p class="caption">'+fmt(c.nonMissingCount,0)+' present · '+fmt(c.uniqueCount,0)+' distinct · '+fmt(c.missingCount,0)+' missing. Percentages use present values.</p>';
}
function renderTime(){
 const c=selectedColumn('date-select');if(!c?.dates){$('time-chart').innerHTML=empty('No valid date column was identified.');return}
 const d=c.dates,w=460,h=215,L=38,R=12,T=22,B=42,iw=w-L-R,ih=h-T-B;
 const monthMode=d.calendarDays>120,counts=monthMode?d.monthCounts:d.dayCounts,first=counts[0],last=counts[counts.length-1];
 const serial=row=>monthMode?Number(row.month.slice(0,4))*12+Number(row.month.slice(5,7))-1:Math.floor(Date.parse(row.date+'T00:00:00Z')/86400000);
 const start=serial(first),end=serial(last),span=Math.max(1,end-start+1),max=counts.reduce((m,r)=>Math.max(m,r.count),1);let body='';
 for(let k=0;k<=3;k++){const y=T+ih-ih*k/3;body+='<line class="grid" x1="'+L+'" x2="'+(w-R)+'" y1="'+y+'" y2="'+y+'"/><text x="'+(L-7)+'" y="'+(y+3)+'" text-anchor="end">'+fmt(max*k/3,1)+'</text>'}
 counts.forEach(row=>{const x=L+((serial(row)-start)/span)*iw,bw=Math.max(1,iw/span-1),bh=row.count/max*ih;body+='<rect class="time-bar" x="'+x+'" y="'+(T+ih-bh)+'" width="'+bw+'" height="'+bh+'"><title>'+esc(row.date||row.month)+': '+row.count+' records</title></rect>'});
 body+='<text x="'+L+'" y="'+(h-18)+'">'+esc(first.date||first.month)+'</text><text x="'+(w-R)+'" y="'+(h-18)+'" text-anchor="end">'+esc(last.date||last.month)+'</text><text x="'+L+'" y="10">RECORDS PER '+(monthMode?'MONTH':'DAY')+'</text>';
 $('time-chart').innerHTML=svg(body,'Record counts by '+(monthMode?'month':'day')+' for '+c.name,w,h)+'<div class="summary-grid"><div><span>First day</span><strong>'+d.min.slice(0,10)+'</strong></div><div><span>Last day</span><strong>'+d.max.slice(0,10)+'</strong></div><div><span>Observed days</span><strong>'+fmt(d.distinctDays,0)+'</strong></div></div><p class="caption">'+fmt(d.daysWithoutRecords,0)+' calendar days without records within the covered interval. Date grouping uses UTC for profiling; source values are preserved.</p>';
}
function renderCorrelations(t){
 const pairs=t.numericPairs||[];if(!pairs.length){$('correlation-chart').innerHTML=empty('At least two numeric measures are needed. IDs are excluded.');return}
 const usable=pairs.filter(p=>Number.isFinite(p.r)).sort((a,b)=>Math.abs(b.r)-Math.abs(a.r)),unusable=pairs.filter(p=>!Number.isFinite(p.r));
 const shown=[...usable,...unusable].slice(0,12);
 $('correlation-chart').innerHTML='<table class="correlation-table"><thead><tr><th>Pair</th><th>r</th><th>Pairwise n</th></tr></thead><tbody>'+shown.map(p=>'<tr><td>'+esc(p.xName)+'<br><span class="caption">× '+esc(p.yName)+'</span></td><td><span class="corr-value">'+fmt(p.r,3)+'</span><span class="corr-count">'+esc(p.status)+(p.smallSample?' · small n':'')+'</span></td><td class="numeric">'+fmt(p.n,0)+'</td></tr>').join('')+'</tbody></table><p class="caption">Showing '+shown.length+' of '+pairs.length+' pairs'+(usable.length?', ordered by absolute correlation for exploration':'')+'. No significance tests or causal ranking. Each pair uses its own complete cases.</p>';
}
function renderQuality(t){
 const outlierCells=t.columns.reduce((sum,c)=>sum+(c.numeric?.outlierCount||0),0),issues=t.issues||[],errors=t.rowErrors?.length||0;
 const groupText=t.duplicateGroups.slice(0,5).map(g=>'rows '+g.rows.slice(0,12).join(', ')+(g.rows.length>12?'…':'')).join('; ');
 $('quality-results').innerHTML='<div class="signal-grid"><div class="signal"><strong>'+fmt(t.duplicateCount,0)+'</strong><span>Exact repeated rows beyond the first occurrence</span></div><div class="signal"><strong>'+fmt(outlierCells,0)+'</strong><span>Numeric cells beyond IQR fences; a row can count more than once</span></div></div>'+(groupText?'<p class="caption">Duplicate groups: '+esc(groupText)+'. Values and original types are compared; absent and null are distinct.</p>':'<p class="caption">No exact duplicate rows found. This does not rule out duplicate business events.</p>')+(errors?'<p class="notice warning">'+errors+' parsing issue(s). Treat malformed CSV as diagnostic only; correct the source before importing into a depot.</p>':'')+'<ul class="quality-issues">'+issues.slice(0,30).map(i=>'<li>'+esc(i.message||i)+'</li>').join('')+'</ul>'+(issues.length>30?'<p class="caption">Showing 30 of '+issues.length+' review signals. The downloaded profile contains the full list.</p>':'');
}
function renderPreview(t){
 const cols=t.columns.slice(0,12),rows=t.previewRows;
 $('preview-label').textContent=rows.length+' of '+fmt(t.rowCount,0)+' rows · '+cols.length+' of '+t.columnCount+' fields';
 $('data-preview').innerHTML='<table><thead><tr><th>Row</th>'+cols.map(c=>'<th>'+esc(c.name)+'</th>').join('')+'</tr></thead><tbody>'+rows.map((row,i)=>'<tr><td>'+String(i+1)+'</td>'+cols.map(c=>{const text=pretty(row[c.key]);return '<td title="'+esc(text.slice(0,1000))+'">'+esc(text.slice(0,160))+(text.length>160?'…':'')+'</td>'}).join('')+'</tr>').join('')+'</tbody></table>';
}
function renderTable(){
 const t=currentTable();if(!t)return;
 const cells=t.rowCount*t.columnCount,missing=t.columns.reduce((a,c)=>a+c.missingCount,0),complete=cells?100*(cells-missing)/cells:null;
 $('analysis-kpis').innerHTML=[['ROWS',fmt(t.rowCount,0),'Observations in the selected table'],['FIELDS',fmt(t.columnCount,0),'Union of flattened field paths'],['PRESENT CELLS',complete===null?'—':fmt(complete,1)+'%','Coverage, not an accuracy score'],['EXACT REPEATS',fmt(t.duplicateCount,0),'Occurrences beyond the first']].map(([name,value,note])=>'<article><p>'+name+'</p><strong>'+value+'</strong><small>'+note+'</small></article>').join('');
 let notes=[];if(currentKind==='synthetic')notes.push('<p class="warning"><strong>Synthetic demonstration.</strong> These invented records exercise the profiler and include a deliberate duplicate and missing value. They are not the hackathon archive or real farm observations.</p>');
 if(currentKind==='reference')notes.push('<p><strong>Unassigned reference source.</strong> These tables are being explored without a farm assignment. Analysis does not create harvest records or change data-sharing permissions.</p>');
 if(t.rowCount>0&&t.rowCount<30)notes.push('<p>Only '+t.rowCount+' observations are available in this table. Distributions and correlations are descriptive and may be unstable; no inference to a farm population is justified.</p>');
 if(!t.rowCount)notes.push('<p class="warning">The selected table has no rows. Completeness, averages and distributions are undefined.</p>');
 const topIssues=(current.issues||[]).slice(0,5);topIssues.forEach(i=>notes.push('<p class="'+(i.severity==='error'?'warning':'')+'">'+esc(i.message||i)+'</p>'));
 const numericCount=t.columns.filter(c=>c.numeric).length;if(numericCount>24)notes.push('<p>Correlations cover the first 24 numeric columns. All '+numericCount+' numeric fields have complete univariate profiles.</p>');
 $('analysis-notes').innerHTML=notes.join('');
 renderMissingness(t);renderTypes(t);renderColumns();
 setOptions('numeric-select',t.columns.filter(c=>c.numeric));setOptions('category-select',t.columns.filter(c=>!c.numeric&&!c.dates&&c.type!=='structured'&&c.type!=='empty'));setOptions('date-select',t.columns.filter(c=>c.dates));
 renderNumeric();renderCategory();renderTime();renderCorrelations(t);renderQuality(t);renderPreview(t);
}
function renderReport(){
 $('analysis-results').hidden=false;$('analysis-empty').hidden=true;
 $('dataset-kind').textContent=currentKind==='synthetic'?'Synthetic example':currentKind==='reference'?'Reference source · unassigned':currentKind==='depot'?'Current depot export':'Imported source file';$('dataset-kind').className='pill '+(currentKind==='synthetic'||currentKind==='reference'?'amber':'green');
 $('dataset-title').textContent=current.source.filename;
 const hashLabel=current.source.sha256Basis==='original-file-bytes'?'original file bytes':'generated UTF-8 text';
 $('dataset-description').textContent=fmt(current.source.tableCount,0)+' table(s) · '+fmt(current.source.rowCount,0)+' total rows · '+fmt(current.source.sizeBytes/1024,1)+' KiB · no sampling'+(checksum?' · SHA-256 ('+hashLabel+') '+checksum.slice(0,16)+'…':'');
 $('table-select').innerHTML=current.tables.map((t,i)=>'<option value="'+i+'">'+esc(t.name)+' ('+t.rowCount+')</option>').join('');$('table-select').value=String(selected);$('table-select').disabled=current.tables.length<2;
 if(!archiveContext&&currentKind!=='synthetic'){
  $('availability-title').textContent=currentKind==='reference'?'A reference source is loaded for local analysis.':'A source file is loaded for local analysis.';
  $('availability-text').textContent='The interactive section profiles '+current.source.filename+'. '+(currentKind==='reference'?'No farm is assigned and no harvest records are created. ':'')+'The architecture sections remain an audit of the pinned original code. File import into this report does not publish data or change depot permissions.';
  $('scope-kpi').textContent=fmt(current.source.rowCount,0)+' rows';$('scope-kpi-caption').textContent='Across '+current.source.tableCount+' imported table(s); not distinct farms';
  $('evidence-dataset').textContent=current.source.filename+(checksum?' · SHA-256 ('+hashLabel+') '+checksum:' · checksum unavailable');
 }else if(!archiveContext){$('availability-title').textContent='A labelled example is loaded; the source archive is still pending.';$('availability-text').textContent=sourceText;$('scope-kpi').textContent='Awaiting file';$('scope-kpi-caption').textContent='Example rows are not real farm data';$('evidence-dataset').textContent='Synthetic example only; original archive bytes unavailable'}
 renderTable();
}
function delimiterOptions(){const value=$('delimiter').value;return value==='auto'?{}:{delimiter:value==='tab'?'\t':value}}
async function analyze(text,filename,kind='file',options={}){
 const token=++loadToken;status('Reading and profiling every row…');
 await new Promise(resolve=>setTimeout(resolve,0));
 try{
  const report=E.analyzeText(text,{filename,format:'auto',...delimiterOptions()});
  const bytes=options.sourceBytes||new TextEncoder().encode(text);
  report.source.decodedTextBytes=report.source.sizeBytes;
  report.source.sizeBytes=bytes.byteLength;
  report.source.sha256Basis=options.sourceBytes?'original-file-bytes':'generated-utf8-text';
  let hash=null;if(window.crypto?.subtle){const digest=await crypto.subtle.digest('SHA-256',bytes);hash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')}
  if(token!==loadToken)return;
  current=report;currentKind=kind!=='synthetic'&&report.sourceData?._terravivaDataset?.role==='reference'?'reference':kind;selected=0;checksum=hash;loadedAt=new Date().toISOString();renderReport();status('Analysis complete. '+fmt(report.source.rowCount,0)+' rows profiled. Data remains in this page’s memory.');
 }catch(error){if(token!==loadToken)return;status(error.message+(current?' Previous analysis is still displayed; it has not been replaced.':''),true)}
}
async function loadFile(file){
 if(!file)return;
 const token=++loadToken;
 if(file.size>E.limits.maxFileBytes){status('File exceeds the 20 MiB report limit. No analysis or import was performed.',true);return}
 if(!/\.(csv|tsv|json)$/i.test(file.name)){status('Choose a CSV, TSV or JSON file. Extract ZIP archives first.',true);return}
 try{
  const bytes=await file.arrayBuffer();
  if(token!==loadToken)return;
  if(bytes.byteLength>E.limits.maxFileBytes)throw Error('The file exceeds the 20 MiB report limit.');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw Error('The file is not valid UTF-8. Export it as UTF-8 and try again.');}
  await analyze(text,file.name,'file',{sourceBytes:bytes});
 }catch(e){if(token===loadToken)status('Could not read this file: '+e.message,true)}
}
function clear(){loadToken++;current=null;currentKind='';selected=0;checksum=null;loadedAt=null;$('analysis-results').hidden=true;$('analysis-empty').hidden=false;$('data-file').value='';$('pasted-data').value='';if(!archiveContext){$('availability-title').textContent='The source archive has not been loaded.';$('availability-text').textContent=sourceText;$('scope-kpi').textContent='Awaiting file';$('scope-kpi-caption').textContent='No production row count inferred';$('evidence-dataset').textContent='Source bytes not available in this report version'}status(archiveContext?'Cleared the interactive analysis. The supplied archive report is unchanged.':'Cleared. No observations loaded.');['column-table','data-preview','analysis-notes','quality-results','correlation-chart','numeric-chart','numeric-summary','missingness-chart','type-chart','category-chart','time-chart','analysis-kpis'].forEach(id=>$(id).replaceChildren())}
function downloadProfile(){if(!current)return;const artifact={report:'Terraviva data profile',engineVersion:E.version,generatedAt:loadedAt,evidenceKind:currentKind,source:{...current.source,sha256:checksum},method:current.method,limits:current.limits,issues:current.issues,notes:current.notes,tables:current.tables.map(({rows,flatRows,previewRows,...profile})=>profile)};const blob=new Blob([JSON.stringify(artifact,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='terraviva-data-profile.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('Profile downloaded. It excludes raw rows but includes category values and may still contain sensitive information.');}
function downloadArchiveProfile(){if(!archiveContext)return;const blob=new Blob([JSON.stringify(archiveContext,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='terraviva-archive-analysis.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('Archive analysis downloaded. It contains the permanent report statistics, category values and source evidence; no raw source rows.');}
const example={example_only:true,description:'Invented report demonstration, not farm observations or the hackathon archive.',records:[{id:'example-01',product:'wheat',volume:12,field:'North Field',date:'2026-10-01',moisture_pct:12.4},{id:'example-02',product:'wheat',volume:8,field:'South Field',date:'2026-10-03',moisture_pct:13.1},{id:'example-03',product:'barley',volume:5.5,field:'East Field',date:'2026-10-05',moisture_pct:11.7},{id:'example-04',product:'maize',volume:18,field:'River Field',date:'2026-10-08',moisture_pct:15.3},{id:'example-05',product:'barley',volume:6.25,field:null,date:'2026-10-09',moisture_pct:12.0},{id:'example-06',product:'wheat',volume:9,field:'North Field',date:'2026-10-12',moisture_pct:null},{id:'example-07',product:'maize',volume:44,field:'River Field',date:'2026-10-14',moisture_pct:14.8},{id:'example-01',product:'wheat',volume:12,field:'North Field',date:'2026-10-01',moisture_pct:12.4}]};
$('data-file').addEventListener('change',e=>loadFile(e.target.files[0]));$('example-button').addEventListener('click',()=>analyze(JSON.stringify(example),'synthetic-report-example.json','synthetic'));$('analyse-paste').addEventListener('click',()=>analyze($('pasted-data').value,'pasted-data','file'));$('clear-data').addEventListener('click',clear);$('download-profile').addEventListener('click',downloadProfile);$('table-select').addEventListener('change',()=>{selected=Number($('table-select').value);$('column-search').value='';renderTable()});$('column-search').addEventListener('input',renderColumns);$('numeric-select').addEventListener('change',renderNumeric);$('category-select').addEventListener('change',renderCategory);$('date-select').addEventListener('change',renderTime);
if(archiveContext)$('download-archive-profile')?.addEventListener('click',downloadArchiveProfile);
const zone=$('dropzone');['dragenter','dragover'].forEach(name=>zone.addEventListener(name,event=>{event.preventDefault();zone.classList.add('dragging')}));['dragleave','drop'].forEach(name=>zone.addEventListener(name,event=>{event.preventDefault();zone.classList.remove('dragging')}));zone.addEventListener('drop',event=>{if(event.dataTransfer.files.length!==1){status('Choose one CSV or JSON file at a time. A JSON file can contain several tables.',true);return}loadFile(event.dataTransfer.files[0])});
$('print-report').addEventListener('click',()=>{document.querySelectorAll('.method-details').forEach(d=>d.open=true);window.print()});
$('engine-limits').textContent='Interactive profiler limits: 20 MiB per file, 100,000 total rows, 250 columns per table, 2,000,000 total cells and 32 tables. All rows within these limits are profiled. Correlations cover the first 24 numeric fields; every field receives a univariate profile. Tables show a maximum 12-row preview.'+(archiveContext?' The permanent archive analysis has its own declared scope and methods above; these browser limits do not describe its coverage.':'');
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){document.querySelectorAll('.sidebar nav a').forEach(a=>a.classList.toggle('active',a.hash==='#'+entry.target.id))}})},{rootMargin:'-5% 0px -75% 0px',threshold:0});document.querySelectorAll('.section-anchor').forEach(section=>observer.observe(section))}
let received=false;window.addEventListener('message',event=>{
 if(received||!window.opener||event.source!==window.opener||event.origin!==location.origin||!/^https?:$/.test(location.protocol))return;
 const payload=event.data?.payload;
 if(event.data?.type==='terraviva-report-data'){
  if(!payload||!Array.isArray(payload.records)||typeof payload.farm!=='string')return;
  received=true;return analyze(JSON.stringify(payload),'depot-export-'+payload.farm+'.json','depot');
 }
 if(event.data?.type!=='terraviva-source-report-data')return;
 try{
  if(!payload||typeof payload.filename!=='string'||payload.filename.length>255||/[\\/\u0000-\u001f\u007f]/.test(payload.filename)||! /\.(csv|tsv|json)$/i.test(payload.filename))throw Error('The app supplied an unsupported source filename.');
  const supplied=payload.bytes,tag=Object.prototype.toString.call(supplied);
  let bytes;if(tag==='[object ArrayBuffer]')bytes=new Uint8Array(supplied);
  else if(ArrayBuffer.isView(supplied)&&tag==='[object Uint8Array]')bytes=new Uint8Array(supplied.buffer,supplied.byteOffset,supplied.byteLength);
  else throw Error('The app must supply original source bytes as an ArrayBuffer or Uint8Array.');
  if(!bytes.byteLength||bytes.byteLength>E.limits.maxFileBytes)throw Error('The app source must contain 1 byte to 20 MiB.');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw Error('The app source is not valid UTF-8. Export it as UTF-8 and try again.');}
  received=true;return analyze(text,payload.filename,'file',{sourceBytes:bytes});
 }catch(error){status('Source analysis could not start: '+error.message,true)}
});
if(window.opener&&/^https?:$/.test(location.protocol))window.opener.postMessage({type:'terraviva-report-ready'},location.origin);
try{const embedded=JSON.parse($('initial-dataset').textContent);if(embedded?.text)analyze(embedded.text,embedded.filename||'embedded-dataset.json',embedded.kind||'file')}catch(error){status('Embedded dataset could not be read: '+error.message,true)}
})();
