(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else {root.TerravivaReference=api;if(root.document)api.mount(root.document).catch(error=>{const node=root.document.getElementById('catalog-status');if(node){node.textContent=error.message;node.classList.add('is-error')}})}
})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const MAX_COMPRESSED_BYTES=24*1024*1024,MAX_DECODED_BYTES=32*1024*1024,VIEW_ROWS=100;
const FILTER_COLUMNS={operation:['operation_type'],country:['country_code','country','nuts0_id'],year:['year'],crop:['native_crop_code','crop_group_code','crop_code','crop','product','product_name','product_type']};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fmt=value=>Number(value).toLocaleString('en-GB');
const abortError=()=>Object.assign(Error('The request was cancelled.'),{name:'AbortError'});
function checkAbort(signal){if(signal?.aborted)throw abortError()}
function safeAssetURL(file,origin){
  if(typeof file!=='string'||file.length>500||!file||!/^[a-zA-Z0-9_./-]+$/.test(file)||file.startsWith('/')||file.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('This source contains an unsupported reference-data path.');
  const url=new URL('/reference/'+file,origin);
  if(url.origin!==origin||!url.pathname.startsWith('/reference/'))throw Error('Reference data must stay within this app.');
  return url;
}
function validateColumns(columns){
  if(!Array.isArray(columns)||!columns.length||columns.length>2000||columns.some(c=>typeof c!=='string'||!c.length)||new Set(columns).size!==columns.length)throw Error('The source column list is invalid.');
}
function validateCatalog(catalog){
  if(!catalog||catalog.kind!=='terraviva-reference-catalog'||catalog.schemaVersion!==1||!Array.isArray(catalog.datasets)||catalog.datasets.length>1000)throw Error('The source catalogue has an unsupported format.');
  const ids=new Set();
  for(const dataset of catalog.datasets){
    if(!dataset||typeof dataset.id!=='string'||!dataset.id||ids.has(dataset.id)||dataset.role!=='reference'||dataset.farmerAssignment!==null||!integer(dataset.rowCount)||!Array.isArray(dataset.pages))throw Error('A source catalogue entry is invalid or has a farmer assignment.');
    ids.add(dataset.id);validateColumns(dataset.columns);
    if(!dataset.source||typeof dataset.source.path!=='string'||!integer(dataset.source.bytes)||!hash(dataset.source.sha256))throw Error('A source is missing its original-file identity.');
    let next=1;
    for(const page of dataset.pages){
      safeAssetURL(page.file,'https://reference.invalid');
      if(!integer(page.rows)||page.rows<1||page.rows>20000||page.firstRow!==next||page.lastRow!==next+page.rows-1||!integer(page.bytes)||!page.bytes||page.bytes>MAX_COMPRESSED_BYTES||!integer(page.decodedBytes)||!page.decodedBytes||page.decodedBytes>MAX_DECODED_BYTES||!hash(page.sha256)||!hash(page.decodedSha256))throw Error('A source page has invalid bounds or integrity metadata.');
      next=page.lastRow+1;
    }
    if(next-1!==dataset.rowCount)throw Error('The source page counts do not cover the complete table.');
    if(dataset.profile){safeAssetURL(dataset.profile.file,'https://reference.invalid');if(!integer(dataset.profile.bytes)||dataset.profile.bytes>MAX_DECODED_BYTES||!hash(dataset.profile.sha256))throw Error('A source profile is missing its integrity metadata.')}
  }
  return catalog;
}
async function readBounded(response,limit,signal){
  checkAbort(signal);
  if(!response.ok)throw Error('The source could not be loaded (HTTP '+response.status+').');
  const declared=response.headers?.get?.('content-length');
  if(declared&&Number(declared)>limit)throw Error('The source exceeds its expected size.');
  if(!response.body?.getReader){const bytes=new Uint8Array(await response.arrayBuffer());checkAbort(signal);if(bytes.length>limit)throw Error('The source exceeds its expected size.');return bytes}
  const reader=response.body.getReader(),chunks=[];let length=0;
  try {while(true){checkAbort(signal);const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit)throw Error('The source exceeds its expected size.');chunks.push(value)}}
  catch(error){await reader.cancel().catch(()=>{});throw error}
  finally{reader.releaseLock()}
  checkAbort(signal);const joined=new Uint8Array(length);let offset=0;for(const part of chunks){joined.set(part,offset);offset+=part.length}return joined;
}
async function sha256(bytes,cryptoAPI=globalThis.crypto){
  if(!cryptoAPI?.subtle)throw Error('This browser cannot verify source checksums. Open the secure site in a current browser.');
  return [...new Uint8Array(await cryptoAPI.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
function decodeJSON(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw Error('The source is not valid UTF-8 JSON.')}}
async function inflateGzip(bytes,limit,signal){
  if(typeof DecompressionStream!=='function')throw Error('This browser cannot open compressed source pages. Use a current browser with gzip decompression support.');
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return readBounded({ok:true,status:200,body:stream},limit,signal);
}
function validatePage(page,dataset,descriptor){
  if(!page||page.datasetId!==dataset.id||page.role!=='reference'||page.farmerAssignment!==null||page.firstRow!==descriptor.firstRow||page.lastRow!==descriptor.lastRow||!Array.isArray(page.rows)||page.rows.length!==descriptor.rows||JSON.stringify(page.columns)!==JSON.stringify(dataset.columns))throw Error('The page does not match its source catalogue.');
  for(const row of page.rows)if(!Array.isArray(row)||row.length!==dataset.columns.length||row.some(value=>value!==null&&typeof value!=='string'))throw Error('The page contains changed or malformed source values.');
  if(page.sourceLines!==undefined&&(!Array.isArray(page.sourceLines)||page.sourceLines.length!==page.rows.length||page.sourceLines.some((line,index)=>line!==descriptor.firstRow+index)))throw Error('The page source positions are inconsistent.');
  return page;
}
async function loadPage(dataset,descriptor,options={}){
  const fetcher=options.fetch||globalThis.fetch,origin=options.origin||globalThis.location?.origin,signal=options.signal;
  const response=await fetcher(safeAssetURL(descriptor.file,origin),{credentials:'omit',signal,cache:'no-cache'});
  const compressed=await readBounded(response,Math.min(descriptor.bytes,MAX_COMPRESSED_BYTES),signal);
  if(compressed.length!==descriptor.bytes||await sha256(compressed,options.crypto)!==descriptor.sha256)throw Error('Source integrity check failed: the compressed page does not match its checksum.');
  checkAbort(signal);
  const decoded=await (options.inflate||inflateGzip)(compressed,Math.min(descriptor.decodedBytes,MAX_DECODED_BYTES),signal);
  if(decoded.length!==descriptor.decodedBytes||await sha256(decoded,options.crypto)!==descriptor.decodedSha256)throw Error('Source integrity check failed: the decoded page does not match its checksum.');
  checkAbort(signal);return validatePage(decodeJSON(decoded),dataset,descriptor);
}
async function loadProfile(dataset,options={}){
  if(!dataset.profile)return null;
  const descriptor=dataset.profile,signal=options.signal;
  const response=await (options.fetch||globalThis.fetch)(safeAssetURL(descriptor.file,options.origin||globalThis.location?.origin),{credentials:'omit',signal,cache:'no-cache'});
  const bytes=await readBounded(response,descriptor.bytes,signal);
  if(bytes.length!==descriptor.bytes||await sha256(bytes,options.crypto)!==descriptor.sha256)throw Error('The field-profile checksum does not match the source catalogue.');
  const profile=decodeJSON(bytes);
  if(!profile||!Array.isArray(profile.columns))throw Error('The source field profile has an unsupported format.');
  return profile;
}
function filterFields(columns){return Object.fromEntries(Object.entries(FILTER_COLUMNS).map(([key,names])=>[key,names.filter(name=>columns.includes(name))]))}
function normalizeFilters(filters={}){return Object.fromEntries([...Object.keys(FILTER_COLUMNS),'text'].map(key=>[key,String(filters[key]||'').trim().toLowerCase()]))}
function hasFilters(filters){return Object.values(filters).some(Boolean)}
function matcher(columns,filters={}){
  const values=normalizeFilters(filters),indices=Object.fromEntries(Object.entries(filterFields(columns)).map(([key,names])=>[key,names.map(name=>columns.indexOf(name))]));
  for(const key of Object.keys(FILTER_COLUMNS))if(values[key]&&!indices[key].length)throw Error('This source has no '+key+' field. Clear that filter to continue.');
  return row=>{
    for(const key of Object.keys(FILTER_COLUMNS))if(values[key]&&!indices[key].some(index=>row[index]!==null&&row[index].toLowerCase()===values[key]))return false;
    return !values.text||row.some(value=>value!==null&&value.toLowerCase().includes(values.text));
  };
}
function createExplorer(options){
  const pageLoader=options.loadPage,onChange=options.onChange||(()=>{}),viewRows=options.viewRows||VIEW_ROWS,yieldControl=options.yieldControl||(()=>new Promise(resolve=>setTimeout(resolve,0)));
  const state={dataset:null,rows:[],offset:0,total:0,filters:normalizeFilters(),matchCounts:null,busy:false,progress:null,error:'',notice:'',verifiedPages:0};
  let generation=0,controller=null;
  const emit=()=>onChange(state);
  async function task(work){
    controller?.abort();controller=new AbortController();const signal=controller.signal,id=++generation;
    state.busy=true;state.error='';state.notice='';state.progress=null;emit();
    const current=()=>{checkAbort(signal);if(id!==generation)throw abortError()};
    const getPage=async descriptor=>{current();const page=await pageLoader(state.dataset,descriptor,{signal});current();state.verifiedPages++;return page};
    try{await work({signal,current,getPage})}
    catch(error){if(id===generation&&error.name!=='AbortError')state.error=error.message||'The source could not be read.'}
    finally{if(id===generation){state.busy=false;state.progress=null;emit()}}
  }
  async function select(dataset){
    controller?.abort();state.dataset=dataset;state.rows=[];state.offset=0;state.total=dataset.rowCount;state.filters=normalizeFilters();state.matchCounts=null;state.verifiedPages=0;
    await goTo(0);
  }
  async function windowRows(offset,counts,filters,getPage,current){
    const selected=[],predicate=matcher(state.dataset.columns,filters);let before=0,remaining=viewRows;
    for(let pageIndex=0;pageIndex<state.dataset.pages.length&&remaining>0;pageIndex++){
      const descriptor=state.dataset.pages[pageIndex],count=counts?counts[pageIndex]:descriptor.rows;
      if(before+count<=offset){before+=count;continue}
      const page=await getPage(descriptor);let matchNumber=before;
      for(let rowIndex=0;rowIndex<page.rows.length&&remaining>0;rowIndex++)if(predicate(page.rows[rowIndex])){
        if(matchNumber>=offset){selected.push({sourceRow:descriptor.firstRow+rowIndex,values:page.rows[rowIndex]});remaining--}matchNumber++;
      }
      before+=count;current();
    }
    return selected;
  }
  async function goTo(requestedOffset){
    if(!state.dataset)return;
    const offset=Math.max(0,Math.min(Math.floor(requestedOffset/viewRows)*viewRows,Math.max(0,Math.floor((state.total-1)/viewRows)*viewRows)));
    await task(async({current,getPage})=>{const rows=await windowRows(offset,state.matchCounts,state.filters,getPage,current);current();state.rows=rows;state.offset=offset});
  }
  async function applyFilters(input){
    if(!state.dataset)return;const filters=normalizeFilters(input);let predicate;
    try{predicate=matcher(state.dataset.columns,filters)}catch(error){state.error=error.message;emit();return}
    await task(async({current,getPage})=>{
      if(!hasFilters(filters)){const rows=await windowRows(0,null,filters,getPage,current);current();state.rows=rows;state.filters=filters;state.matchCounts=null;state.total=state.dataset.rowCount;state.offset=0;return}
      const counts=[],firstRows=[];let total=0,scanned=0;
      for(let index=0;index<state.dataset.pages.length;index++){
        const descriptor=state.dataset.pages[index],page=await getPage(descriptor);let count=0;
        for(let rowIndex=0;rowIndex<page.rows.length;rowIndex++){
          if(rowIndex&&rowIndex%2000===0){await yieldControl();current()}
          if(predicate(page.rows[rowIndex])){count++;if(firstRows.length<viewRows)firstRows.push({sourceRow:descriptor.firstRow+rowIndex,values:page.rows[rowIndex]})}
        }
        counts.push(count);total+=count;scanned+=page.rows.length;state.progress={scanned,total:state.dataset.rowCount,pages:index+1,pageCount:state.dataset.pages.length,matched:total};emit();await yieldControl();current();
      }
      current();state.rows=firstRows;state.matchCounts=counts;state.filters=filters;state.total=total;state.offset=0;state.notice='Search complete. Every row in this source was checked.';
    });
  }
  function cancel(){controller?.abort();generation++;state.busy=false;state.progress=null;state.notice='Cancelled. The previous results are unchanged.';state.error='';emit()}
  return {state,select,goTo,applyFilters,cancel,viewRows};
}
function rowObject(columns,values){return Object.fromEntries(columns.map((name,index)=>[name,values[index]]))}
function unitFor(name,row){
  if(name==='quantity')return row.quantity_unit||'';
  if(name==='quantity_per_static_head')return row.quantity_unit?row.quantity_unit+' / static head':'';
  if(name==='volume_t')return 't';if(name==='price_eur_t'||name.endsWith('_price_eur_t'))return 'EUR/t';
  if(name.endsWith('_eur'))return 'EUR';
  if(name==='avg_number'||name==='static_head_count')return 'head (source basis)';
  return '';
}
function contextFor(name,row){
  const parts=[];
  if(name.endsWith('_eur')){if(row.farm_value_status)parts.push('Value status: '+row.farm_value_status);if(row.structure_time_status)parts.push('Structure: '+row.structure_time_status)}
  if(name==='avg_number'&&row.livestock_temporal_basis)parts.push('Basis: '+row.livestock_temporal_basis);
  if(['static_head_count','quantity_per_static_head'].includes(name)&&row.temporal_basis)parts.push('Basis: '+row.temporal_basis);
  if(name==='quantity'&&row.temporal_basis)parts.push('Temporal basis: '+row.temporal_basis);
  return parts;
}
function valueHTML(value){return value===null?'<span class="null-value">NULL</span>':value===''?'<span class="empty-value">Empty text</span>':esc(value)}
function cellHTML(name,value,row){
  const unit=unitFor(name,row),context=contextFor(name,row);
  return '<span class="source-value" title="'+esc(value===null?'NULL':JSON.stringify(value))+'">'+valueHTML(value)+'</span>'+(unit?'<span class="cell-unit">'+esc(unit)+'</span>':'')+context.map(text=>'<span class="cell-context">'+esc(text)+'</span>').join('');
}
function overviewColumns(columns){
  let preferred;
  if(columns.includes('farm_value_status'))preferred=['holding_id','year','country','total_output_eur','farm_value_status','structure_time_status'];
  else if(columns.includes('animal_product_id'))preferred=['animal_product_id','holding_id','year','product','quantity','quantity_unit','static_head_count','temporal_basis'];
  else if(columns.includes('livestock_temporal_basis'))preferred=['holding_id','year','animal_category','avg_number','livestock_temporal_basis'];
  else if(columns.includes('operation_type'))preferred=['source_operation_id','operation_type','year','operation_date','holding_id','parcel_id','native_crop_code','seed_rate_kg_ha'];
  else if(columns.includes('transaction_id'))preferred=['transaction_id','holding_id','year','product','volume_t','price_eur_t','certification_status'];
  else preferred=columns.slice(0,7);
  return preferred.filter(name=>columns.includes(name));
}
function detailsHTML(dataset,record,profile){
  const row=rowObject(dataset.columns,record.values),dictionary=new Map((profile?.columns||[]).map(column=>[column.name,column]));
  return dataset.columns.map((name,index)=>{
    const metadata=dictionary.get(name),unit=unitFor(name,row)||(typeof metadata?.unit==='string'?metadata.unit:''),context=contextFor(name,row);
    return '<article class="field-detail"><h3>'+esc(name)+'</h3><code>'+valueHTML(record.values[index])+'</code>'+(unit?'<span class="field-unit">Unit: '+esc(unit)+'</span>':'')+context.map(text=>'<span class="cell-context">'+esc(text)+'</span>').join('')+(metadata?.description?'<p>'+esc(metadata.description)+'</p>':'')+'</article>';
  }).join('');
}
function interpretation(dataset){
  const columns=dataset.columns;
  if(columns.includes('farm_value_status'))return 'The financial values are synthetic. Structure and labour are repeated from a static source. Read farm_value_status and structure_time_status beside each monetary value; this panel is not evidence of observed farm accounts.';
  if(columns.includes('animal_product_id'))return 'MILK quantities use tonnes; EGGS use 1,000 pieces. Keep product units separate. Static herd denominators are not annual herd measurements, and may contain fractional values.';
  if(columns.includes('livestock_temporal_basis'))return 'This is a static livestock inventory. A missing year does not make it an annual measurement. Keep livestock_temporal_basis beside the source count.';
  if(columns.includes('operation_type'))return 'The retrieved part-3 operation files contain planting. Narrow operation tables can repeat the core fields of enriched tables. Regional context, synthetic irrigation, and campaign years require their source status fields.';
  if(columns.includes('transaction_id'))return 'Sales values are synthetic. Holding certificates describe holding and date validity, not batch or parcel lineage. Joining multiple certificates can repeat a sale.';
  return 'Read the source grain and field definitions before combining tables. Synthetic, static, and regional context describe different evidence. Source tables may overlap with other files in this collection.';
}
function titleFor(dataset){
  const name=dataset.source.path.split('/').pop();
  const titles={combined_animal_product_ready:'Annual animal products',combined_challenge1_farm_reporting_ready:'Annual farm-reporting panel',combined_challenge3_sales_certification_ready:'Sales & certificate context',combined_column_provenance:'Column definitions & lineage',combined_table_provenance:'Table provenance',combined_livestock_static_ready:'Static livestock inventory',combined_subsidy_summary:'Annual subsidy summary',combined_crop_mapping:'Crop-code mapping',combined_holding_region:'Holdings & regions',combined_region_assignment:'Region assignment',combined_region_climate_normals:'Regional climate normals',combined_region_crop_availability:'Regional crop availability',combined_sale_certificate_link:'Sale–certificate links',combined_sale_certificate_summary:'Certificate summary by sale',combined_quality_issues:'Source quality notes',combined_sql_examples:'Example SQL queries',crop_sources:'Crop-source catalogue'};
  const key=name.replace(/\.csv$/i,'');if(titles[key])return titles[key];
  const planting=key.match(/^combined_challenge2_parcel_operations_ready_(\d{4})_part_(\d+)$/);if(planting)return 'Planting context · '+planting[1]+' · part '+planting[2];
  const operation=key.match(/^combined_operation_records_(\d{4})_part_(\d+)$/);if(operation)return 'Operation core · '+operation[1]+' · part '+operation[2];
  return (dataset.title||key).replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
}
function byteLabel(bytes){return bytes>=1000000?(bytes/1000000).toLocaleString('en-GB',{maximumFractionDigits:1})+' MB':fmt(bytes)+' B'}
async function mount(document){
  const byId=id=>document.getElementById(id),origin=globalThis.location.origin;
  if(!byId('dataset-select'))return;
  const status=byId('catalog-status');
  const response=await fetch('/reference/index.json',{credentials:'omit',cache:'no-cache'});
  const catalog=validateCatalog(decodeJSON(await readBounded(response,4*1024*1024)));
  const totals=catalog.datasets.reduce((out,d)=>({rows:out.rows+d.rowCount,bytes:out.bytes+d.source.bytes}),{rows:0,bytes:0});
  byId('source-count').textContent=fmt(catalog.datasets.length);byId('row-count').textContent=fmt(totals.rows);byId('source-bytes').textContent=byteLabel(totals.bytes);
  byId('dataset-select').innerHTML=catalog.datasets.map(dataset=>'<option value="'+esc(dataset.id)+'">'+esc(titleFor(dataset))+' · '+fmt(dataset.rowCount)+' rows</option>').join('');
  if(!catalog.datasets.length){status.textContent='No source tables are available in this collection.';return}
  status.hidden=true;byId('explorer').hidden=false;
  let profile=null,profileRequest=null,selection=0,profileWarning='',columnMode='overview',previousFocus=null;
  const model=createExplorer({loadPage:(dataset,page,{signal})=>loadPage(dataset,page,{origin,signal}),onChange:render});
  function render(state){
    const dataset=state.dataset;if(!dataset)return;
    const controls=['apply-filters','clear-filters','previous-page','next-page','filter-operation','filter-country','filter-year','filter-crop','filter-text'];
    controls.forEach(id=>{byId(id).disabled=state.busy});
    const available=filterFields(dataset.columns);for(const key of Object.keys(FILTER_COLUMNS))byId('filter-'+key).disabled=state.busy||!available[key].length;
    byId('cancel-scan').hidden=!state.busy;byId('column-mode').disabled=state.busy;
    byId('previous-page').disabled=state.busy||state.offset===0;byId('next-page').disabled=state.busy||state.offset+model.viewRows>=state.total;
    const work=byId('work-status');work.classList.toggle('is-error',!!state.error);
    work.textContent=state.error||(state.progress?'Scanning '+fmt(state.progress.scanned)+' / '+fmt(state.progress.total)+' rows · '+fmt(state.progress.matched)+' matches so far…':state.busy?'Loading and verifying source records…':state.notice||profileWarning||'');
    const shown=state.rows.length,filtered=hasFilters(state.filters);
    byId('result-description').textContent=(filtered?fmt(state.total)+' matches in '+fmt(dataset.rowCount)+' source rows. ':fmt(dataset.rowCount)+' source rows. ')+(shown?'Displaying '+fmt(state.offset+1)+'–'+fmt(state.offset+shown)+'.':'');
    byId('page-description').textContent=state.total?'Page '+fmt(Math.floor(state.offset/model.viewRows)+1)+' of '+fmt(Math.ceil(state.total/model.viewRows))+' · '+model.viewRows+' records per page':'0 matching records';
    byId('integrity-status').textContent=state.verifiedPages?'Source-page checksums verified':'Checksums checked on load';
    const columns=columnMode==='all'?dataset.columns:overviewColumns(dataset.columns);
    byId('records-head').innerHTML='<tr><th scope="col">Record</th>'+columns.map(name=>'<th scope="col">'+esc(name)+'</th>').join('')+'<th scope="col">All fields</th></tr>';
    byId('records-body').innerHTML=state.rows.map((record,index)=>{const row=rowObject(dataset.columns,record.values);return '<tr><td class="row-number">'+fmt(record.sourceRow)+'</td>'+columns.map(name=>'<td>'+cellHTML(name,row[name],row)+'</td>').join('')+'<td><button class="record-open" type="button" data-record="'+index+'" aria-label="Open all fields for source record '+record.sourceRow+'">Open ↗</button></td></tr>'}).join('');
    byId('empty-state').hidden=shown!==0||state.busy||!!state.error;byId('records-table').hidden=shown===0&&!state.busy;
  }
  function setSuggestions(dataset){
    const available=filterFields(dataset.columns),dictionary=new Map((profile?.columns||[]).map(column=>[column.name,column]));
    for(const [key,names] of Object.entries(available)){
      const values=[...new Set(names.flatMap(name=>(dictionary.get(name)?.frequencies||[]).map(item=>item.value??item.label)).filter(value=>typeof value==='string'&&value.length<=100))].sort();
      byId(key+'-values').innerHTML=values.slice(0,200).map(value=>'<option value="'+esc(value)+'"></option>').join('');
      byId('filter-'+key).title=names.length?'Matches complete values in: '+names.join(', '):'This source has no '+key+' field.';
    }
    byId('filter-help').textContent='Category filters match complete values without regard to letter case. Text search matches part of a value. Every search checks all rows in this source.'+(available.crop.length?' Crop / product searches: '+available.crop.join(', ')+'.':'')+' Years use the source year field; they are not inferred from dates.';
  }
  async function select(id){
    const dataset=catalog.datasets.find(item=>item.id===id);if(!dataset)return;
    const current=++selection;profileRequest?.abort();profileRequest=new AbortController();profile=null;profileWarning='';
    if(byId('record-dialog').open)byId('record-dialog').close();
    for(const key of [...Object.keys(FILTER_COLUMNS),'text'])byId('filter-'+key).value='';
    byId('dataset-description').textContent=titleFor(dataset);byId('records-title').textContent=titleFor(dataset);
    byId('source-facts').innerHTML='<div><dt>Source rows</dt><dd>'+fmt(dataset.rowCount)+'</dd></div><div><dt>Fields</dt><dd>'+fmt(dataset.columns.length)+'</dd></div><div><dt>Assignment</dt><dd>Reference · unassigned</dd></div><div class="grain"><dt>One row represents</dt><dd>'+esc(dataset.grain||'See the source documentation for this table’s grain.')+'</dd></div>';
    byId('source-provenance').innerHTML='<p>Original source<code>'+esc(dataset.source.path)+'</code></p><p>Original bytes<code>'+fmt(dataset.source.bytes)+'</code></p><p>Original-file SHA-256<code>'+esc(dataset.source.sha256)+'</code></p><p>Each browser page is checked against its compressed and decoded SHA-256 before any records are displayed. Original source bytes remain identified separately.</p>';
    byId('interpretation-note').textContent=interpretation(dataset);setSuggestions(dataset);
    const loadingProfile=loadProfile(dataset,{origin,signal:profileRequest.signal}).then(result=>{if(current===selection){profile=result;setSuggestions(dataset)}}).catch(error=>{if(current===selection&&error.name!=='AbortError')profileWarning='Field definitions could not be verified. Source records can still be explored. '+error.message});
    await model.select(dataset);await loadingProfile;if(current===selection)render(model.state);
  }
  byId('dataset-select').addEventListener('change',event=>select(event.target.value));
  byId('filter-form').addEventListener('submit',event=>{event.preventDefault();model.applyFilters(Object.fromEntries([...Object.keys(FILTER_COLUMNS),'text'].map(key=>[key,byId('filter-'+key).value])))});
  byId('clear-filters').addEventListener('click',()=>{for(const key of [...Object.keys(FILTER_COLUMNS),'text'])byId('filter-'+key).value='';model.applyFilters({})});
  byId('cancel-scan').addEventListener('click',()=>model.cancel());
  byId('previous-page').addEventListener('click',()=>model.goTo(model.state.offset-model.viewRows));
  byId('next-page').addEventListener('click',()=>model.goTo(model.state.offset+model.viewRows));
  byId('column-mode').addEventListener('change',event=>{columnMode=event.target.value;render(model.state)});
  byId('records-body').addEventListener('click',event=>{
    const button=event.target.closest?.('button[data-record]');if(!button)return;
    const record=model.state.rows[Number(button.dataset.record)],dataset=model.state.dataset;if(!record)return;
    previousFocus=button;byId('record-title').textContent='Source record '+fmt(record.sourceRow);
    byId('record-context').textContent=dataset.source.path+' · '+dataset.columns.length+' fields · verified source page · reference data, unassigned. Values retain their source text.';
    byId('record-fields').innerHTML=detailsHTML(dataset,record,profile);byId('record-dialog').showModal();
  });
  byId('close-record').addEventListener('click',()=>byId('record-dialog').close());
  byId('record-dialog').addEventListener('close',()=>previousFocus?.focus());
  await select(catalog.datasets[0].id);
}
return {MAX_COMPRESSED_BYTES,MAX_DECODED_BYTES,VIEW_ROWS,safeAssetURL,validateCatalog,readBounded,sha256,decodeJSON,inflateGzip,validatePage,loadPage,loadProfile,filterFields,normalizeFilters,matcher,createExplorer,overviewColumns,unitFor,contextFor,cellHTML,detailsHTML,interpretation,titleFor,mount};
});
