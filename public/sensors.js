(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else{root.TerravivaSensors=api;if(root.document)api.mount(root.document,root.SensorCore,root.TerravivaEDA)}})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const MAX_BATCH_BYTES=256*1024,MAX_BATCH_ROWS=500,PAGE_SIZE=50;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=value=>Number(value).toLocaleString('en-GB');
const label=value=>String(value||'').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
const qualityLabel=value=>({ok:'OK · source flag',unverified:'Unverified',suspect:'Suspect',invalid:'Invalid'}[value]||'Unknown source flag');
function validateSnapshot(data){
  if(!data||data.role!=='private-sensor-data'||data.commercialUse!=='not-enabled-by-this-module'||typeof data.farm!=='string'||!data.farm||!Array.isArray(data.readings)||data.readings.length>10000||!Array.isArray(data.devices))throw Error('The depot returned an unsupported sensor response.');
  for(const key of ['capacity','remaining','stateBytes','maxStateBytes'])if(data[key]!==undefined&&(!Number.isSafeInteger(data[key])||data[key]<0))throw Error('The depot returned invalid storage capacity metadata.');
  if(data.capacity!==undefined&&data.capacity<data.readings.length)throw Error('The depot returned inconsistent reading capacity.');
  if(data.maxStateBytes!==undefined&&data.maxStateBytes===0)throw Error('The depot returned invalid shared storage capacity.');
  for(const row of data.readings){
    if(!row||['id','deviceId','field','observedAt','measurement','value','unit','quality','receivedAt'].some(key=>typeof row[key]!=='string')||!Number.isFinite(Date.parse(row.observedAt))||!Number.isFinite(Date.parse(row.receivedAt))||!['unverified','ok','suspect','invalid'].includes(row.quality))throw Error('The depot returned an incomplete sensor reading.');
    if(row.farm!==undefined&&row.farm!==data.farm)throw Error('The depot returned a reading for a different farm.');
  }
  for(const device of data.devices)if(!device||typeof device.deviceId!=='string'||(device.farm!==undefined&&device.farm!==data.farm))throw Error('The depot returned an invalid device identity.');
  return data;
}
async function responseJSON(response){
  if(!response?.ok){let data;try{data=await response.json()}catch{}throw Object.assign(Error(data?.error||'Sensor depot unavailable. Try refreshing again.'),{issues:Array.isArray(data?.issues)?data.issues:[]})}
  try{return await response.json()}catch{throw Error('The sensor depot did not return a readable response.')}
}
function createSession(options){
  const core=options.core,fetcher=options.fetch||globalThis.fetch,now=options.now||Date.now,onChange=options.onChange||(()=>{});
  if(!core?.initial||!core?.prepare||!core?.merge)throw Error('The sensor tools have not loaded. Refresh this page to try again.');
  let demo=core.initial(),token='',generation=0,controller=null;
  const state={mode:'demo',farm:null,readings:demo.readings,devices:[],capacity:10000,busy:false,error:'',issues:[],message:'',lastLoadedAt:null,contextVersion:0,stateBytes:null,maxStateBytes:null};
  const emit=()=>onChange(state);
  const fail=error=>{state.error=error.message||'Unable to complete this action.';state.issues=Array.isArray(error.issues)?error.issues:[]};
  async function read(candidate,connecting){
    if(typeof candidate!=='string'||candidate.length<32){fail(Error('Use an administrator-issued farmer access token.'));emit();return false}
    controller?.abort();controller=new AbortController();const signal=controller.signal,id=++generation,expectedFarm=connecting?null:state.farm;
    state.busy=true;state.error='';state.issues=[];state.message='';emit();const activeController=controller,timer=setTimeout(()=>activeController.abort(),20000);
    try {
      const response=await fetcher('/api/sensors',{method:'GET',headers:{Authorization:'Bearer '+candidate},credentials:'omit',cache:'no-store',signal});
      const data=validateSnapshot(await responseJSON(response));
      if(id!==generation||signal.aborted)return false;
      if(expectedFarm&&data.farm!==expectedFarm)throw Error('The farm identity changed during refresh. Disconnect and reconnect before continuing.');
      token=candidate;if(connecting||state.farm!==data.farm)state.contextVersion++;state.mode='connected';state.farm=data.farm;state.readings=data.readings;state.devices=data.devices;state.capacity=Number.isSafeInteger(data.capacity)?data.capacity:10000;state.stateBytes=data.stateBytes??null;state.maxStateBytes=data.maxStateBytes??null;state.lastLoadedAt=new Date(now()).toISOString();state.message='Loaded '+fmt(data.readings.length)+' readings for '+data.farm+'.';return true;
    } catch(error){if(id===generation)fail(error.name==='AbortError'?Error('The sensor request timed out. Existing readings are unchanged.'):error);return false}
    finally{clearTimeout(timer);if(id===generation){state.busy=false;emit()}}
  }
  function addDemo(rows){
    if(state.mode!=='demo')throw Error('Connected readings arrive through registered gateways. Demo imports are available after disconnecting.');
    if(state.busy)return false;state.error='';state.issues=[];state.message='';
    try {const stamp=now(),prepared=core.prepare(rows,{now:stamp}),result=core.merge(demo,prepared,{now:stamp});demo=result.state;state.readings=demo.readings;state.message=fmt(result.accepted)+' demo reading'+(result.accepted===1?'':'s')+' added; '+fmt(result.duplicates)+' exact repeat'+(result.duplicates===1?'':'s')+' skipped.';emit();return true}
    catch(error){fail(error);emit();return false}
  }
  function disconnect(){controller?.abort();generation++;token='';state.contextVersion++;state.mode='demo';state.farm=null;state.readings=demo.readings;state.devices=[];state.capacity=10000;state.stateBytes=null;state.maxStateBytes=null;state.busy=false;state.lastLoadedAt=null;state.error='';state.issues=[];state.message='Disconnected. Your local demo is shown; private readings have been cleared from the view.';emit()}
  function cancelPending(){controller?.abort();generation++;state.busy=false;state.error='';state.issues=[];state.message='Connection request cancelled.';emit()}
  function displayError(error){fail(error);emit()}
  return {state,addDemo,connect:candidate=>read(candidate,true),refresh:()=>token?read(token,false):Promise.resolve(false),disconnect,cancelPending,displayError};
}
function parseBatch(text,filename,EDA){
  if(new TextEncoder().encode(text).length>MAX_BATCH_BYTES)throw Error('Sensor batches are limited to 256 KiB.');
  let rows;
  if(/\.csv$/i.test(filename)){
    const parsed=EDA.parseCSV(text);
    if(parsed.rowErrors.length||parsed.headers.some((header,index)=>header!==parsed.originalHeaders[index]))throw Error('The CSV has malformed rows or changed, repeated, or blank headers. Use the exact sensor field names.');
    rows=parsed.rows;
  } else if(/\.json$/i.test(filename)){
    const data=EDA.parseJSON(text).data;
    if(Array.isArray(data))rows=data;
    else if(data&&typeof data==='object'&&Object.keys(data).length===1&&Array.isArray(data.readings))rows=data.readings;
    else throw Error('Use a JSON array or an object containing only a readings array. Farm identity and permissions are not imported from a file.');
  } else throw Error('Choose a UTF-8 CSV or JSON file.');
  if(!Array.isArray(rows)||!rows.length||rows.length>MAX_BATCH_ROWS)throw Error('Provide between 1 and 500 sensor readings per batch.');
  // Preserve fields for the shared validator; nothing is silently discarded.
  if(new TextEncoder().encode(JSON.stringify({readings:rows})).length>MAX_BATCH_BYTES)throw Error('The expanded sensor batch exceeds 256 KiB. Split it into smaller batches.');
  return rows;
}
async function readBatchFile(file,EDA){
  if(!file||file.size>MAX_BATCH_BYTES)throw Error('Choose a sensor batch of at most 256 KiB.');
  const bytes=await file.arrayBuffer();if(bytes.byteLength>MAX_BATCH_BYTES)throw Error('The sensor batch exceeds 256 KiB.');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw Error('The sensor file is not valid UTF-8. No readings were saved.')}
  return parseBatch(text,file.name,EDA);
}
function summarize(readings){
  const latest=new Map(),devices=new Set();let review=0,unverified=0;
  for(const row of readings){devices.add(row.deviceId);if(row.quality==='suspect'||row.quality==='invalid')review++;if(row.quality==='unverified')unverified++;
    const key=JSON.stringify([row.deviceId,row.field,row.measurement,row.unit]),previous=latest.get(key);
    if(!previous||Date.parse(row.observedAt)>Date.parse(previous.observedAt)||(Date.parse(row.observedAt)===Date.parse(previous.observedAt)&&Date.parse(row.receivedAt)>Date.parse(previous.receivedAt)))latest.set(key,row);
  }
  return {total:readings.length,devices:devices.size,review,unverified,latest:[...latest.values()].sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))};
}
function filterReadings(readings,filters={}){
  return readings.filter(row=>(!filters.device||row.deviceId===filters.device)&&(!filters.measurement||row.measurement===filters.measurement)&&(!filters.quality||(filters.quality==='review'?['suspect','invalid'].includes(row.quality):row.quality===filters.quality))).slice().sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)||Date.parse(b.receivedAt)-Date.parse(a.receivedAt)||a.deviceId.localeCompare(b.deviceId)||a.id.localeCompare(b.id));
}
function rowsHTML(readings){return readings.map(row=>'<tr><td><strong>'+esc(row.deviceId)+'</strong><small>'+esc(row.id)+'</small></td><td>'+esc(row.field)+'</td><td><code>'+esc(row.observedAt)+'</code></td><td>'+esc(label(row.measurement))+'</td><td><span class="sensor-value">'+esc(row.value)+'</span><span class="sensor-unit">'+esc(row.unit)+'</span></td><td><span class="quality '+esc(row.quality)+'">'+esc(qualityLabel(row.quality))+'</span></td><td><code>'+esc(row.receivedAt)+'</code></td></tr>').join('')}
function exportData(state,now=Date.now()){
  return {kind:state.mode==='connected'?'private-sensor-data':'local-sensor-demo',farm:state.mode==='connected'?state.farm:null,exportedAt:new Date(now).toISOString(),commercialUse:'not-enabled-by-this-module',readings:state.readings.map(row=>({...row}))};
}
function capacityNote(state){
  const slots=Math.max(0,state.capacity-state.readings.length);
  if(state.mode!=='connected')return fmt(slots)+' reading slots remain in this tab’s demo';
  const base='Up to '+fmt(slots)+' further readings; the shared depot storage limit also applies.';
  return Number.isSafeInteger(state.stateBytes)&&Number.isSafeInteger(state.maxStateBytes)?base+' '+fmt(state.stateBytes)+' / '+fmt(state.maxStateBytes)+' bytes used.':base;
}
function mount(document,core,EDA){
  const $=id=>document.getElementById(id);if(!$('sensor-rows'))return;
  let session,offset=0,file=null,lastContext=-1;
  try{session=createSession({core,onChange:render})}catch(error){$('sensor-status').textContent=error.message;$('sensor-status').classList.add('is-error');return}
  const measurements=core.MEASUREMENTS;
  $('reading-measurement').innerHTML=Object.keys(measurements).map(name=>'<option value="'+esc(name)+'">'+esc(label(name))+'</option>').join('');
  function selectedUnit(){const value=measurements[$('reading-measurement').value];return typeof value==='string'?value:typeof value?.unit==='string'?value.unit:Array.isArray(value)?value[0]:''}
  function updateUnit(){$('reading-unit').textContent='· '+selectedUnit()}
  function optionsFor(node,values,text=label){const previous=node.value;node.innerHTML='<option value="">'+(node.id==='sensor-device-filter'?'All devices':'All measurements')+'</option>'+values.map(value=>'<option value="'+esc(value)+'">'+esc(text(value))+'</option>').join('');if(values.includes(previous))node.value=previous}
  function render(state){
    if(lastContext!==state.contextVersion){lastContext=state.contextVersion;offset=0;for(const id of ['sensor-device-filter','sensor-measurement-filter','sensor-quality-filter'])$(id).value=''}
    const connected=state.mode==='connected',summary=summarize(state.readings);
    $('sensor-mode').textContent=connected?'CONNECTED FARM DEPOT':'LOCAL DEMO';$('sensor-farm').textContent=connected?state.farm:'This tab’s demo';
    $('sensor-mode-note').textContent=connected?'Private readings from your farm’s registered gateways. Refresh to check for new data. Last loaded: '+state.lastLoadedAt:'No sensor is connected. Demo readings stay in this tab and disappear when it closes or reloads.';
    $('connect-sensors').textContent=connected?'Disconnect':'Connect my sensor depot';$('connect-sensors').disabled=state.busy;$('refresh-sensors').hidden=!connected;$('refresh-sensors').disabled=state.busy;
    $('demo-entry').hidden=connected;$('export-sensors').disabled=state.busy||!state.readings.length;$('sensor-login-submit').disabled=state.busy;
    $('reading-total').textContent=fmt(summary.total);$('device-total').textContent=fmt(summary.devices);$('review-total').textContent=fmt(summary.review);$('unverified-total').textContent=fmt(summary.unverified);
    $('capacity-note').textContent=capacityNote(state);
    const status=$('sensor-status');status.classList.toggle('is-error',!!state.error);status.innerHTML=state.error?'<strong>'+esc(state.error)+'</strong>'+(state.issues.length?'<ul class="error-list">'+state.issues.slice(0,20).map(issue=>'<li>Row '+esc(issue.index??issue.row??'?')+' · '+esc(issue.field||'reading')+': '+esc(issue.message||'Invalid reading')+'</li>').join('')+'</ul>':''):esc(state.busy?'Loading your farm’s sensor readings…':state.message);
    $('latest-section').hidden=!summary.total;$('latest-readings').innerHTML=summary.latest.slice(0,6).map(row=>'<article class="latest-card"><h3>'+esc(label(row.measurement))+'</h3><div class="latest-value">'+esc(row.value)+'<span>'+esc(row.unit)+'</span></div><p>'+esc(row.deviceId)+' · '+esc(row.field)+'</p><p>Measured '+esc(row.observedAt)+'</p><span class="quality '+esc(row.quality)+'">'+esc(qualityLabel(row.quality))+'</span></article>').join('');
    optionsFor($('sensor-device-filter'),[...new Set(state.readings.map(row=>row.deviceId))].sort(),value=>value);optionsFor($('sensor-measurement-filter'),[...new Set(state.readings.map(row=>row.measurement))].sort());
    renderRows();
  }
  function renderRows(){
    const state=session.state,rows=filterReadings(state.readings,{device:$('sensor-device-filter').value,measurement:$('sensor-measurement-filter').value,quality:$('sensor-quality-filter').value});
    offset=Math.max(0,Math.min(offset,Math.floor(Math.max(rows.length-1,0)/PAGE_SIZE)*PAGE_SIZE));const visible=rows.slice(offset,offset+PAGE_SIZE);
    $('sensor-rows').innerHTML=rowsHTML(visible);$('sensor-result-count').textContent=rows.length?fmt(rows.length)+' matching readings · displaying '+fmt(offset+1)+'–'+fmt(offset+visible.length)+'. Sorted by measurement time.':'No readings match the current view.';
    $('sensor-empty').hidden=!!rows.length;$('sensor-empty-note').textContent=state.readings.length?'Try another device, measurement, or quality filter.':state.mode==='connected'?'No readings have arrived for this farm. Its registered gateways can send data when configured.':'Add a demo reading or import a batch below. A connected farm fills when a registered gateway sends data.';
    $('sensor-page').textContent=rows.length?'Page '+fmt(offset/PAGE_SIZE+1)+' of '+fmt(Math.ceil(rows.length/PAGE_SIZE)):'0 records';$('sensor-previous').disabled=offset===0;$('sensor-next').disabled=offset+PAGE_SIZE>=rows.length;
  }
  $('reading-measurement').addEventListener('change',updateUnit);updateUnit();
  $('reading-now').addEventListener('click',()=>{$('reading-time').value=new Date().toISOString()});
  $('reading-form').addEventListener('submit',event=>{
    event.preventDefault();if(session.state.mode!=='demo')return;
    try {if(!$('reading-id').value)$('reading-id').value=crypto.randomUUID();
      const row={id:$('reading-id').value,deviceId:$('reading-device').value,field:$('reading-field').value,observedAt:$('reading-time').value,measurement:$('reading-measurement').value,value:$('reading-value').value,unit:selectedUnit(),quality:$('reading-quality').value};
      if(session.addDemo([row])){$('reading-id').value='';$('reading-value').value='';offset=0;renderRows()}
    } catch(error){session.displayError(error)}
  });
  $('sensor-file').addEventListener('change',event=>{file=event.target.files[0]||null;$('batch-file-note').textContent=file?file.name+' · '+fmt(file.size)+' bytes':'No file selected.'});
  $('batch-form').addEventListener('submit',async event=>{event.preventDefault();if(session.state.mode!=='demo')return;const selected=file,context=session.state.contextVersion;$('save-demo-batch').disabled=true;try{const rows=await readBatchFile(selected,EDA);if(session.state.mode!=='demo'||session.state.contextVersion!==context)throw Error('The destination changed. Return to the local demo before importing.');session.addDemo(rows);offset=0;renderRows()}catch(error){session.displayError(error)}finally{$('save-demo-batch').disabled=false}});
  for(const id of ['sensor-device-filter','sensor-measurement-filter','sensor-quality-filter'])$(id).addEventListener('change',()=>{offset=0;renderRows()});
  $('sensor-previous').addEventListener('click',()=>{offset-=PAGE_SIZE;renderRows()});$('sensor-next').addEventListener('click',()=>{offset+=PAGE_SIZE;renderRows()});
  $('connect-sensors').addEventListener('click',()=>{if(session.state.mode==='connected'){session.disconnect();offset=0}else{$('sensor-login-error').textContent='';$('sensor-login').showModal()}});
  $('sensor-login-cancel').addEventListener('click',()=>{$('sensor-token').value='';session.cancelPending();$('sensor-login').close()});
  $('sensor-login').addEventListener('cancel',()=>{$('sensor-token').value='';session.cancelPending()});
  $('sensor-login-form').addEventListener('submit',async event=>{event.preventDefault();const candidate=$('sensor-token').value;$('sensor-token').value='';if(await session.connect(candidate)){$('sensor-login').close();offset=0;renderRows()}else $('sensor-login-error').textContent=session.state.error});
  $('refresh-sensors').addEventListener('click',()=>session.refresh());
  $('export-sensors').addEventListener('click',()=>{const data=exportData(session.state),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=session.state.mode==='connected'?'terraviva-sensor-readings.json':'terraviva-sensor-demo.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
  render(session.state);
}
return {MAX_BATCH_BYTES,MAX_BATCH_ROWS,PAGE_SIZE,validateSnapshot,createSession,parseBatch,readBatchFile,summarize,filterReadings,rowsHTML,exportData,capacityNote,mount};
});
