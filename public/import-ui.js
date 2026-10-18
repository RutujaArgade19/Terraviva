(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TerraImportUI=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const MAX_BYTES=1024*1024,MAX_ROWS=1000;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const own=(object,key)=>object!==null&&typeof object==='object'&&Object.hasOwn(object,key);
const valueAt=(row,path)=>path.reduce((value,key)=>own(value,key)?value[key]:undefined,row);
const identityName=name=>/^(farm|farm[ _-]?id)$/i.test(name);
const columnName=column=>String(column.path[column.path.length-1]||'').toLowerCase();
const metricUnit=value=>typeof value==='string'?({t:'t',tonne:'t',tonnes:'t',kg:'kg',kilogram:'kg',kilograms:'kg'})[value.trim().toLowerCase()]:undefined;
function decodeUTF8(bytes){
  if(bytes.byteLength>MAX_BYTES)throw Error('This file exceeds the 1 MiB app import limit.');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw Error('This file is not valid UTF-8. Export it as UTF-8 and try again; no records were imported.')}
}
async function readUTF8File(file){return decodeUTF8(await file.arrayBuffer())}
function claimsIn(value){
  const claims=[],stack=[{value,path:'$'}];
  while(stack.length){const node=stack.pop();if(!node.value||typeof node.value!=='object')continue;
    for(const [key,item] of Object.entries(node.value)){
      const path=node.path+'.'+key;
      if(identityName(key))claims.push({path,value:item});
      if(item&&typeof item==='object')stack.push({value:item,path});
    }
  }
  return claims;
}
function checkClaims(claims,farm){
  for(const claim of claims){
    if(typeof claim.value!=='string'||claim.value!==farm)throw Error('Farm identity at '+claim.path+' does not match the destination '+farm+'. Choose a file for this farm; no rows were imported.');
  }
}
function defaults(table){
  const find=name=>{const index=table.columns.findIndex(column=>columnName(column)===name);return index<0?'':String(index)};
  const amount=find('volume')||find('quantity');
  const unit=find('unit');
  return {product:find('product'),amount,field:find('field'),date:find('date'),id:find('id'),farm:find('farm')||find('farm_id'),unit,unitMode:unit!==''?'column':''};
}
function mappedRows(table,mapping,farm,claims=[]){
  if(!table||!Array.isArray(table.rows)||!table.rows.length)throw Error('Choose a table containing harvest records.');
  if(table.rows.length>MAX_ROWS)throw Error('This table contains '+table.rows.length+' rows. Import at most 1,000 harvest records per batch; use the report to analyse a larger source.');
  if(table.rowErrors?.length)throw Object.assign(Error('This CSV has malformed rows or a column-count mismatch. Correct the source before importing; no partial rows are saved.'),{issues:table.rowErrors});
  checkClaims(claims,farm);
  for(const key of ['product','amount','field','date'])if(mapping[key]===''||!table.columns[Number(mapping[key])])throw Error('Map the '+({amount:'quantity'}[key]||key)+' column before previewing.');
  const read=(row,key)=>mapping[key]===''?undefined:valueAt(row,table.columns[Number(mapping[key])].path);
  const amountColumn=table.columns[Number(mapping.amount)],canonical=columnName(amountColumn)==='volume';
  const siblingUnits=table.columns.filter(column=>columnName(column)==='unit'&&JSON.stringify(column.path.slice(0,-1))===JSON.stringify(amountColumn.path.slice(0,-1)));
  if(!canonical&&mapping.unitMode!=='kg'&&mapping.unitMode!=='t'&&(mapping.unitMode!=='column'||mapping.unit===''))throw Error('Choose an explicit quantity unit: a unit column, kilograms, or metric tonnes.');
  return table.rows.map((row,index)=>{
    checkClaims(claimsIn(row),farm);
    const output={product:read(row,'product'),field:read(row,'field'),date:read(row,'date')};
    if(canonical){
      for(const column of siblingUnits){const unit=valueAt(row,column.path);if(unit!==undefined&&unit!==null&&unit!==''&&(typeof unit!=='string'||!['t','tonne','tonnes'].includes(unit.trim().toLowerCase())))throw Error('Row '+(index+1)+' declares a non-tonne unit beside canonical volume. Correct the source to quantity + unit for kilograms; volume is always metric tonnes.')}
      output.volume=read(row,'amount');if(mapping.unit!=='')output.unit=read(row,'unit');
    }
    else {
      output.quantity=read(row,'amount');output.unit=mapping.unitMode==='column'?read(row,'unit'):mapping.unitMode;
      // quantity/unit is an explicit source pair. For a different, custom
      // measure, an explicitly selected different unit column may define that
      // measure's units; a forced unit must not erase a conflicting declaration.
      const separateMeasure=columnName(amountColumn)!=='quantity'&&mapping.unitMode==='column'&&mapping.unit!==''&&
        !siblingUnits.some(column=>column===table.columns[Number(mapping.unit)]);
      if(!separateMeasure)for(const column of siblingUnits){
        const declared=valueAt(row,column.path);
        if(declared!==undefined&&declared!==null&&declared!==''&&(!metricUnit(declared)||metricUnit(declared)!==metricUnit(output.unit))){
          throw Error('Row '+(index+1)+' declares '+String(declared)+' for the source quantity. The selected unit conflicts with that declaration. Use its source unit, or select a different measure with its own explicit unit column.');
        }
      }
    }
    if(mapping.id!=='')output.id=read(row,'id');
    if(mapping.farm!==''){
      const declared=read(row,'farm');
      if(declared!==farm)throw Error('Row '+(index+1)+' belongs to a different or unspecified farm. The destination is '+farm+'.');
      output.farm=declared;
    }else if(claims.length)output.farm=farm;
    return output;
  });
}
function safeDatasetURL(file,origin){
  if(typeof file!=='string'||!file||file.length>500||/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(file)||/[?#\\\u0000-\u001f]/.test(file)||/(?:^|\/)\.\.(?:\/|$)|%2e|%2f|%5c/i.test(file))throw Error('This catalogue entry is not a supported local dataset path.');
  const relative=file.replace(/^(?:\.\/)?datasets\//,'');
  const url=new URL(relative,origin+'/datasets/');
  if(url.origin!==origin||!url.pathname.startsWith('/datasets/')||! /\.(csv|json)$/i.test(url.pathname))throw Error('Only CSV and JSON sources in this app’s datasets folder can be loaded.');
  return url;
}
function displayValue(value){if(value===undefined||value===null)return '—';return typeof value==='object'?JSON.stringify(value):String(value)}
function tableHTML(rows,columns,limit=8){
  const selected=columns.slice(0,8);
  return '<div class="table-wrap import-table"><table><thead><tr>'+selected.map(column=>'<th>'+escape(column.name)+'</th>').join('')+'</tr></thead><tbody>'+rows.slice(0,limit).map(row=>'<tr>'+selected.map(column=>'<td title="'+escape(displayValue(valueAt(row,column.path)))+'">'+escape(displayValue(valueAt(row,column.path)).slice(0,160))+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}
function issueHTML(issues){return issues?.length?'<ul class="import-issues">'+issues.slice(0,30).map(issue=>'<li>'+escape(typeof issue==='string'?issue:((issue.row!==undefined?'Row '+issue.row+' · ':'')+(issue.field?issue.field+': ':'')+(issue.message||JSON.stringify(issue))))+'</li>').join('')+'</ul>'+(issues.length>30?'<p class="muted">Showing 30 of '+issues.length+' issues.</p>':''):''}
function create(hooks){
  let draft={},catalog={state:'idle',datasets:[],status:'',unpublished:[],reference:null,error:''};
  const reset=()=>{draft={name:'',bytes:null,analysis:null,tableIndex:null,mapping:{},claims:[],reference:false,plan:null,rows:null,preview:null,result:null,error:'',issues:[],context:null}};
  reset();
  const context=()=>hooks.getContext();
  const sameContext=c=>c&&c.key===context().key&&c.farm===context().farm&&c.connected===context().connected;
  const failure=error=>{draft.error=error.message||'Unable to read this source.';draft.issues=Array.isArray(error.issues)?error.issues:[];draft.plan=null;draft.rows=null;draft.preview=null;draft.result=null};
  const selectedTable=()=>draft.analysis&&draft.tableIndex!==null?draft.analysis.tables[draft.tableIndex]:null;
  function invalidate(){draft.plan=null;draft.rows=null;draft.preview=null;draft.error='';draft.issues=[];draft.result=null}
  function parse(text,name,bytes){
    if(!globalThis.TerravivaEDA?.analyzeText||!globalThis.TerraImport?.prepare)throw Error('The import tools have not loaded. Refresh this page and try again.');
    const analysis=globalThis.TerravivaEDA.analyzeText(text,{filename:name});
    if(!analysis.tables?.length)throw Error('No record tables were found in this source.');
    draft.name=name;draft.bytes=bytes;draft.analysis=analysis;
    draft.claims=claimsIn(analysis.sourceData??analysis.tables.flatMap(table=>table.rows));
    draft.reference=analysis.sourceData?._terravivaDataset?.role==='reference';
    draft.tableIndex=analysis.tables.length===1?0:null;
    draft.mapping=draft.tableIndex===null?{}:defaults(selectedTable());
  }
  async function loadFile(file){
    if(!file||hooks.isBusy())return;
    const destination=context();reset();draft.name=file.name;draft.context=destination;
    hooks.setBusy(true);hooks.refresh();
    try{
      if(file.size>MAX_BYTES)throw Error('This file exceeds the 1 MiB app import limit. Use the report for analysis, then provide a batch of at most 1,000 harvest rows.');
      if(!/\.(csv|json)$/i.test(file.name))throw Error('Choose a CSV or JSON file.');
      const bytes=new Uint8Array(await file.arrayBuffer()),text=decodeUTF8(bytes);
      if(!sameContext(destination))throw Error('The destination changed. Select the file again for the current farm.');
      parse(text,file.name,bytes);
    }catch(error){failure(error)}finally{hooks.setBusy(false);hooks.refresh()}
  }
  async function loadCatalog(){
    catalog.state='loading';
    try{
      const response=await fetch('/datasets/manifest.json',{credentials:'omit',cache:'no-store'});
      if(!response.ok)throw Error('The source catalogue is unavailable. You can still choose a local file.');
      const manifest=await response.json();
      if(!Array.isArray(manifest.datasets))throw Error('The source catalogue has an unsupported format.');
      catalog.datasets=manifest.datasets.filter(entry=>entry&&typeof entry.id==='string'&&typeof entry.name==='string'&&typeof entry.file==='string');
      catalog.status=typeof manifest.status==='string'?manifest.status:'';
      catalog.unpublished=Array.isArray(manifest.unpublishedDatasets)?manifest.unpublishedDatasets:[];
      catalog.reference=manifest.reference&&Number.isSafeInteger(manifest.reference.sourceFiles)&&manifest.reference.sourceFiles>=0&&Number.isSafeInteger(manifest.reference.rows)&&manifest.reference.rows>=0?{sourceFiles:manifest.reference.sourceFiles,rows:manifest.reference.rows}:null;
      catalog.state='ready';
    }catch(error){catalog.state='error';catalog.error=error.message}
    hooks.refresh();
  }
  async function loadSource(entry){
    if(!entry||hooks.isBusy())return;
    const destination=context();reset();draft.context=destination;hooks.setBusy(true);hooks.refresh();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{
      const url=safeDatasetURL(entry.file,location.origin);
      const response=await fetch(url,{credentials:'omit',signal:controller.signal});
      if(!response.ok)throw Error('This source file could not be loaded.');
      if(Number(response.headers.get('content-length'))>MAX_BYTES)throw Error('This source exceeds the 1 MiB app import limit. Open the report to analyse the source.');
      let bytes;
      if(response.body?.getReader){
        const reader=response.body.getReader(),chunks=[];let size=0;
        while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw Error('This source exceeds the 1 MiB app import limit. Provide a smaller harvest batch.')}chunks.push(part.value)}
        const joined=new Uint8Array(size);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength}bytes=joined;
      }else {const blob=await response.blob();if(blob.size>MAX_BYTES)throw Error('This source exceeds the 1 MiB app import limit.');bytes=new Uint8Array(await blob.arrayBuffer())}
      const text=decodeUTF8(bytes);
      if(!sameContext(destination))throw Error('The destination changed. Load the source again for the current farm.');
      parse(text,decodeURIComponent(url.pathname.split('/').pop()),bytes);
    }catch(error){failure(error.name==='AbortError'?Error('Loading the source timed out. Please try again.'):error)}finally{clearTimeout(timer);hooks.setBusy(false);hooks.refresh()}
  }
  function analyseSource(){
    if(hooks.isBusy()||!draft.bytes||!draft.analysis)return;
    if(typeof hooks.analyseSource!=='function'){hooks.status('Source analysis is unavailable. Open the full report and choose this file there.');return}
    // Give the receiver a copy, so a transfer cannot detach the retained source.
    hooks.analyseSource({filename:draft.name,bytes:new Uint8Array(draft.bytes)});
  }
  function preview(){
    if(hooks.isBusy())return;
    invalidate();
    try{
      if(!sameContext(draft.context))throw Error('The destination changed. Select the file again for this farm.');
      const destination=context(),rows=mappedRows(selectedTable(),draft.mapping,destination.farm,draft.claims);
      const plan=globalThis.TerraImport.prepare(rows,{farm:destination.farm,sourceName:draft.name,sourceKind:'dataset'});
      const estimate=globalThis.TerraImport.commit(hooks.getState(),plan,Date.now());
      draft.rows=rows;draft.plan=plan;draft.preview=estimate;
    }catch(error){failure(error)}
    hooks.refresh();
  }
  async function confirm(){
    if(hooks.isBusy()||!draft.plan)return;
    const destination=context();
    if(!sameContext(draft.context)){failure(Error('The destination changed. Preview the file again.'));hooks.refresh();return}
    hooks.setBusy(true);hooks.refresh();
    try{
      const options={farm:destination.farm,sourceName:draft.name,sourceKind:'dataset'};
      const result=destination.connected?await hooks.commitConnected(draft.rows,options):globalThis.TerraImport.commit(hooks.getState(),globalThis.TerraImport.prepare(draft.rows,options),Date.now());
      if(!sameContext(destination))throw Error('The destination changed during this request. Reconnect and check the depot before trying again.');
      if(!result.state||!Array.isArray(result.state.records))throw Error('The depot returned an incomplete result. Check your records before retrying.');
      hooks.updateState(result.state);
      draft.result={added:result.added,skipped:result.skipped,duplicatesInFile:result.duplicatesInFile,warnings:result.warnings||[]};
      draft.plan=null;draft.rows=null;draft.preview=null;
      hooks.status('Import complete: '+result.added+' added, '+result.skipped+' skipped.');
    }catch(error){failure(error)}finally{hooks.setBusy(false);hooks.refresh()}
  }
  function mappingSelect(table,key,label,optional=false){
    return '<label>'+escape(label)+'<select data-import-map="'+key+'"><option value="">'+(optional?'Not present / not used':'Choose a source column')+'</option>'+table.columns.map((column,index)=>'<option value="'+index+'"'+(draft.mapping[key]===String(index)?' selected':'')+'>'+escape(column.name)+'</option>').join('')+'</select></label>';
  }
  function render(container){
    const destination=context(),busy=hooks.isBusy(),table=selectedTable();
    let html='<div class="section-head"><div><p class="eyebrow">BRING YOUR HARVEST RECORDS HOME</p><h2>Data import</h2><p class="muted">Choose a source, inspect its rows, and confirm the records to add.</p></div><a class="link" href="/data-report.html" target="_blank" rel="noopener">Open full data report ↗</a></div>';
    html+='<div class="import-destination"><span class="badge">'+(destination.connected?'Private pilot depot':'Browser demo')+'</span><strong>Destination: '+escape(destination.farm)+'</strong><span>'+(destination.connected?'Confirmed imports are stored in your connected depot.':'Confirmed imports stay in this browser.')+'</span></div>';
    html+='<article class="card space"><p class="eyebrow">01 / SOURCE</p><h3>Choose harvest data for this farm</h3><p class="muted">CSV or JSON · up to 1 MiB · 1,000 rows per batch. Regional statistics and reference tables can be explored in the full report; they are not individual harvest declarations.</p>';
    if(catalog.state==='ready'){
      if(catalog.reference)html+='<div class="import-note"><strong>Hackathon reference collection · '+catalog.reference.sourceFiles.toLocaleString('en-GB')+' sources · '+catalog.reference.rows.toLocaleString('en-GB')+' source-table rows.</strong><p>Explore the retrieved files, filter every row, and inspect field definitions. Sources can overlap; these counts do not represent distinct farms. This collection remains unassigned and does not change your depot or permissions.</p><a class="link" href="/reference-data.html">Explore reference data ↗</a></div>';
      html+='<p class="import-note"><strong>'+(catalog.reference?'Harvest import catalogue':'Repository catalogue')+':</strong> '+catalog.datasets.length+' available table'+(catalog.datasets.length===1?'':'s')+' · '+catalog.unpublished.length+' unpublished table'+(catalog.unpublished.length===1?'':'s')+'.</p>';
      if(catalog.datasets.length)html+='<div class="import-catalog"><label>Repository source<select id="import-catalog"><option value="">Choose an available source</option>'+catalog.datasets.map((entry,index)=>'<option value="'+index+'">'+escape(entry.name)+(Number.isFinite(entry.rows)?' · '+entry.rows+' rows':'')+'</option>').join('')+'</select></label><button class="link" id="import-load-source">Load selected source</button></div>';
      else {
        const message=catalog.status==='requires-split'||catalog.unpublished.length
          ?'Source data has been staged, but '+(catalog.unpublished.length?catalog.unpublished.length+' table(s)':'the available tables')+' need splitting before they can be offered in this catalogue. You can analyse a local file in the full report, or provide a smaller file here.'
          :catalog.reference||catalog.status==='reference-ready'?'The hackathon collection is available in the reference explorer. To add your own harvest records to this farm, choose a local file below.'
          :catalog.status==='awaiting-source-archive'?'The source archive has not been added yet. You can choose a local CSV or JSON file below.'
          :'No browser-ready source files are listed in this catalogue. You can choose a local CSV or JSON file below.';
        html+='<p class="import-note">'+escape(message)+'</p>';
      }
      if(catalog.unpublished.length)html+='<div class="import-note"><strong>Why these tables are unavailable</strong><ul class="import-issues">'+catalog.unpublished.map((entry,index)=>{
        const name=typeof entry?.name==='string'&&entry.name.trim()?entry.name:typeof entry?.id==='string'&&entry.id.trim()?entry.id:'Table '+(index+1);
        const reason=typeof entry?.reason==='string'&&entry.reason.trim()?entry.reason:entry?.status==='requires-split'||catalog.status==='requires-split'?'This table requires splitting before a browser view can be published.':'No publication reason was supplied in the catalogue.';
        return '<li><strong>'+escape(name)+':</strong> '+escape(reason)+'</li>';
      }).join('')+'</ul></div>';
    }
    else html+='<p class="muted">'+escape(catalog.state==='error'?catalog.error:'Checking the source catalogue…')+'</p>';
    html+='<label class="import-file">Local file<input id="import-file" type="file" accept=".csv,.json,text/csv,application/json"></label><p class="muted">'+(draft.name?'Selected: '+escape(draft.name):'Selecting a file only creates a preview.')+'</p>';
    if(draft.analysis&&draft.bytes)html+='<div class="actions"><button class="primary" id="import-analyse-source">Analyse source ↗</button><span class="muted">Explore every table without harvest mapping, farm assignment, or changes to your depot.</span></div>';
    html+='</article>';
    if(draft.analysis){
      html+='<article class="card space"><p class="eyebrow">02 / TABLE &amp; MAPPING</p><h3>Identify the harvest columns</h3><label>Table<select id="import-table"><option value="">Choose a table to inspect</option>'+draft.analysis.tables.map((item,index)=>'<option value="'+index+'"'+(draft.tableIndex===index?' selected':'')+'>'+escape(item.name)+' · '+item.rows.length+' rows</option>').join('')+'</select></label>';
      if(draft.reference)html+='<div class="import-note"><strong>Reference source · no farm has been assigned.</strong> Mapping a table only prepares a preview. Confirm an import only after verifying that the selected rows are harvest records belonging to '+escape(destination.farm)+'. Regional and multi-farm statistics remain reference data.</div>';
      if(table){
        html+='<p class="muted">Raw source preview · first '+Math.min(table.rows.length,8)+' of '+table.rows.length+' rows'+(table.columns.length>8?' · first 8 columns':'')+'. Values have not been changed.</p>'+tableHTML(table.rows,table.columns);
        html+='<div class="import-mapping">'+mappingSelect(table,'product','Product / crop')+mappingSelect(table,'amount','Quantity')+mappingSelect(table,'field','Field name')+mappingSelect(table,'date','Harvest date · YYYY-MM-DD')+mappingSelect(table,'id','Original record ID',true)+mappingSelect(table,'farm','Farm identity column',true)+'</div>';
        const canonical=draft.mapping.amount!==''&&columnName(table.columns[Number(draft.mapping.amount)])==='volume';
        if(canonical)html+='<div class="import-note"><strong>Canonical volume is measured in metric tonnes.</strong> It is never reinterpreted as kilograms. Any mapped source unit must also be tonnes.</div>'+mappingSelect(table,'unit','Source unit column, if present',true);
        else html+='<div class="import-mapping"><label>Quantity unit<select id="import-unit-mode"><option value="">Choose units explicitly</option><option value="column"'+(draft.mapping.unitMode==='column'?' selected':'')+'>Read a unit column</option><option value="kg"'+(draft.mapping.unitMode==='kg'?' selected':'')+'>All quantities are kilograms (kg)</option><option value="t"'+(draft.mapping.unitMode==='t'?' selected':'')+'>All quantities are metric tonnes (t)</option></select></label>'+(draft.mapping.unitMode==='column'?mappingSelect(table,'unit','Unit column'):'')+'</div>';
        html+='<p class="muted">Dates and units are required. No date, unit or farm is guessed. Numeric values use a decimal point; resolve thousands separators in your source before importing. Every row must belong to '+escape(destination.farm)+'.</p><button class="primary" id="import-preview">Preview import</button>';
      }
      html+='</article>';
    }
    if(draft.error)html+='<div class="import-error space" role="alert"><strong>Import not saved</strong><p>'+escape(draft.error)+'</p>'+issueHTML(draft.issues)+'</div>';
    if(draft.plan){
      html+='<article class="card space import-confirm"><p class="eyebrow">03 / REVIEW &amp; CONFIRM</p><h3>Ready for '+escape(destination.farm)+'</h3><div class="import-counts"><div><strong>'+draft.plan.inputRows+'</strong><span>Source rows</span></div><div><strong>'+draft.preview.added+'</strong><span>Will be added</span></div><div><strong>'+draft.preview.skipped+'</strong><span>Will be skipped</span></div></div><p class="muted">'+Number(draft.plan.totalTonnes).toLocaleString(undefined,{maximumFractionDigits:6})+' tonnes in the validated batch. Duplicate matches are skipped. The whole batch must validate before any rows are saved.</p>'+tableHTML(draft.plan.records,[{name:'Product',path:['product']},{name:'Tonnes',path:['volume']},{name:'Field',path:['field']},{name:'Date',path:['date']}])+issueHTML(draft.preview.warnings||draft.plan.warnings)+'<p>Importing adds records to this farm. Existing partner access and your commercial participation choice continue to apply.</p>'+(destination.connected?'<p class="muted">The depot validates again when you confirm; final duplicate counts can change if records arrived since this preview.</p>':'')+'<div class="actions"><button class="primary" id="import-confirm">Confirm import into '+escape(destination.farm)+'</button><button class="link" id="import-cancel-preview">Cancel preview</button></div></article>';
    }
    if(draft.result)html+='<article class="card space import-success" role="status"><h3>Import complete</h3><p><strong>'+draft.result.added+' added</strong> · '+draft.result.skipped+' skipped as duplicates · 0 rejected rows.</p>'+issueHTML(draft.result.warnings)+'<div class="actions"><button class="primary" data-view="depot">View my data depot</button><button class="link" id="analyse-records">Analyse my records ↗</button></div></article>';
    if(busy)html+='<p class="import-loading" role="status">Working… Please wait before changing the destination or starting another import.</p>';
    container.innerHTML=html;
    container.querySelectorAll('input,select,button').forEach(element=>{element.disabled=busy});
    container.querySelector('#import-file').onchange=event=>loadFile(event.target.files[0]);
    const selector=container.querySelector('#import-table');if(selector)selector.onchange=event=>{if(hooks.isBusy())return;invalidate();draft.tableIndex=event.target.value===''?null:Number(event.target.value);draft.mapping=draft.tableIndex===null?{}:defaults(selectedTable());hooks.refresh()};
    container.querySelectorAll('[data-import-map]').forEach(element=>{element.onchange=event=>{if(hooks.isBusy())return;invalidate();draft.mapping[element.dataset.importMap]=event.target.value;hooks.refresh()}});
    const units=container.querySelector('#import-unit-mode');if(units)units.onchange=event=>{if(hooks.isBusy())return;invalidate();draft.mapping.unitMode=event.target.value;hooks.refresh()};
    const button=(id,fn)=>{const element=container.querySelector('#'+id);if(element)element.onclick=fn};
    button('import-preview',preview);button('import-confirm',confirm);button('import-cancel-preview',()=>{if(!hooks.isBusy()){invalidate();hooks.refresh()}});
    button('import-analyse-source',analyseSource);
    button('import-load-source',()=>{const value=container.querySelector('#import-catalog').value;if(value!=='')loadSource(catalog.datasets[Number(value)])});
    if(catalog.state==='idle')loadCatalog();
  }
  return {render,reset};
}
return {create,claimsIn,checkClaims,mappedRows,safeDatasetURL,defaults,readUTF8File,MAX_BYTES,MAX_ROWS};
});
