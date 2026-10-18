'use strict';
const $=s=>document.querySelector(s),esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state=Terra.demo(),view='overview',token='',farm='Demo farm',busy=false,depotVersion=0,reportWindow=null,reportTransfer=null;
let browserKey='terraviva-v2';
function loadBrowserWallet(){
 browserKey='terraviva-v2';let saved=null;
 try{saved=JSON.parse(localStorage.getItem(browserKey))}catch{}
 state=Terra.browserDemo(saved);
 // Empty-but-edited legacy wallets must not block the showcase or be overwritten.
 // An explicit demo URL always selects a separately stored fictional wallet.
 if(!state.records.length||/(?:^|[?&])demo=ana(?:&|$)/.test(location.search||'')){
  browserKey='terraviva-showcase-ana-v1';let sample=null;
  try{sample=JSON.parse(localStorage.getItem(browserKey))}catch{}
  state=sample&&Array.isArray(sample.records)&&sample.records.length&&Array.isArray(sample.grants)&&Array.isArray(sample.events)?sample:Terra.demo();
 }
}
loadBrowserWallet();
function welcome(){return [{who:'bot',text:'SMS simulation — no messages are sent. Your wallet has '+state.records.length+' harvest records ('+state.records.reduce((n,r)=>n+r.volume,0).toFixed(2)+' tonnes). Try SUMMARY, or record a new harvest and reply YES. Then open My data depot to see the change.'}]}
let chat=welcome();
function persist(){if(!token)try{localStorage.setItem(browserKey,JSON.stringify(state))}catch{$('#status').textContent='Browser storage unavailable. Keep this tab open.'}}
async function api(action,extra={},accessToken=token){const r=await fetch('/api/depot',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+accessToken},body:JSON.stringify({action,...extra})});const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error||'Request failed'),{issues:data.issues,code:data.code,status:r.status});return data}
const importView=TerraImportUI.create({getContext:()=>({key:depotVersion,farm,connected:Boolean(token)}),getState:()=>state,isBusy:()=>busy,setBusy:value=>{busy=value},refresh:()=>render(),updateState:value=>{state=value;persist()},commitConnected:(rows,options)=>api('import',{rows,sourceName:options.sourceName,sourceKind:options.sourceKind}),analyseSource,status:text=>{$('#status').textContent=text}});
function sensorSummary(){
 if(!token&&isSample())return '<article class="card space"><p class="eyebrow">ILLUSTRATIVE SENSOR SNAPSHOT · NOT LIVE</p><h2>North Field & Hillside Grove</h2><p>Fictional readings for Ana’s farm. No device is connected and these values are not private-depot records.</p><div class="stats"><article><small>North Field · soil moisture</small><strong>24 <i>%</i></strong><span>12 October 2026 · 08:00 UTC</span></article><article><small>North Field · temperature</small><strong>18.6 <i>°C</i></strong><span>12 October 2026 · 08:00 UTC</span></article><article><small>Hillside Grove · rainfall</small><strong>4.2 <i>mm</i></strong><span>12 October 2026 · daily total</span></article></div><a class="link" href="/sensors.html">Explore the separate sensor simulator ↗</a></article>';
 return TerraSensorSummary.render(state.sensors,{connected:Boolean(token),farm,busy});
}
function isSample(){return state.records.some(r=>r.id==='demo-record-1'&&r.source==='illustrative farmer entry')}
function showcase(){
 if(token||!isSample())return '';
 return '<article class="card space"><p class="eyebrow">ILLUSTRATIVE FARMER · FICTIONAL DATA</p><h2>Ana García · Finca La Ribera</h2><p>Valencia, Spain · 18 hectares · wheat and olives · three fields</p><p>One wallet for harvest records, field observations and time-limited cooperative access. Commercial contribution starts off; Ana chooses whether to participate.</p><h3>Your five-minute demo</h3><div class="actions"><button class="link" data-view="overview">1 · Meet Ana</button><button class="link" data-view="sms">2 · Record by text</button><button class="link" data-view="depot">3 · Open wallet</button><button class="link" data-view="permissions">4 · Control access</button><button class="link" data-view="industry">5 · See shared value</button></div></article>';
}
function downloadJSON(data,filename){const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
async function refreshDepot(){
  if(!token||busy)return;
  const expectedFarm=farm,version=depotVersion;busy=true;render();
  try{const data=TerraSensorSummary.validateDepot(await api('read'),expectedFarm);if(version!==depotVersion)return;state=data.state;changedDepot();$('#status').textContent='Depot refreshed. Your harvest records and received sensor readings are up to date for this snapshot.'}
  catch(error){$('#status').textContent='Refresh failed: '+error.message+' Existing records are unchanged.'}
  finally{busy=false;render()}
}
function changedDepot(){depotVersion++;importView.reset();reportTransfer=null}
function analyseRecords(){
  if(busy){$('#status').textContent='Wait for the current request to finish before opening the analysis.';return}
  reportTransfer={version:depotVersion,payload:structuredClone({farm,records:state.records})};
  reportWindow=window.open('/data-report.html#from-depot','_blank');
  if(!reportWindow){reportTransfer=null;$('#status').textContent='Allow this report window to open, or export your records and open the data report.'}
}
function analyseSource(source){
  if(busy){$('#status').textContent='Wait for the source to finish loading before opening its analysis.';return}
  reportTransfer={version:depotVersion,type:'terraviva-source-report-data',payload:structuredClone(source)};
  reportWindow=window.open('/data-report.html#from-source','_blank');
  if(!reportWindow){reportTransfer=null;$('#status').textContent='Allow this report window to open, or open the data report and choose the source file.'}
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==reportWindow||!reportTransfer||reportTransfer.version!==depotVersion||event.data?.type!=='terraviva-report-ready')return;
  reportWindow.postMessage({type:reportTransfer.type||'terraviva-report-data',payload:reportTransfer.payload},event.origin);
  reportTransfer=null;
});
function stats(){return '<section class="stats"><article><small>Harvest records</small><strong>'+state.records.length+'</strong><span>Confirmed by you</span></article><article><small>Recorded harvest</small><strong>'+state.records.reduce((a,r)=>a+r.volume,0).toFixed(2)+' <i>t</i></strong><span>All recorded dates</span></article><article><small>Active permissions</small><strong>'+state.grants.filter(g=>Terra.active(g,Date.now())).length+'</strong><span>You control access</span></article></section>'}
function records(rows){return rows.length?'<div class="table-wrap"><table><thead><tr><th>Product</th><th>Quantity</th><th>Field</th><th>Date</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.product)+'</td><td>'+esc(r.volume)+' t</td><td>'+esc(r.field)+'</td><td>'+esc(r.date)+'</td></tr>').join('')+'</tbody></table></div>':'<div class="empty">No harvests yet. Record your first one in Text from the field.</div>'}
function render(){
document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
$('#identity').textContent=farm;
$('#refresh-depot').hidden=!token;$('#refresh-depot').disabled=busy;
$('#mode').textContent=token?'Connected pilot depot · Stored centrally. This text panel sends authenticated requests; live SMS requires provider setup.':'Browser demo · '+(isSample()?'Ana García · Fictional sample wallet · ':'')+'Your changes stay on this device. SMS is simulated; no messages are sent.';
const c=$('#content');
if(view==='overview'){const grouped=new Map();for(const r of state.records)grouped.set(r.product,(grouped.get(r.product)||0)+r.volume);
c.innerHTML=stats()+'<div class="two-col"><article class="card"><p class="eyebrow">YOUR HARVEST AT A GLANCE</p><h2>What you have recorded</h2>'+[...grouped.entries()].map(([p,n])=>'<div class="crop"><span>'+esc(p)+'</span><strong>'+n.toFixed(2)+' t</strong></div>').join('')+(!state.records.length?'<p class="muted">Your dashboard fills automatically when you confirm a harvest.</p>':'')+'</article><article class="card green"><p class="eyebrow">VALUE COMES BACK TO YOU</p><h2>One message.<br>Less paperwork.</h2><p>Every confirmed field record becomes part of your depot and dashboard.</p><button class="link" data-view="sms">Record a harvest →</button></article></div><article class="card space"><h3>Commercial participation is '+(state.commercial?'on':'off')+'</h3><p>Your own dashboard works either way. Industry analytics require a separate choice and a sufficiently large participating group.</p><button class="link" data-view="permissions">Manage my choices</button></article>'+sensorSummary()}
if(view==='sms'){c.innerHTML='<div class="section-head"><div><p class="eyebrow">NO APP NEEDED IN THE FIELD</p><h2>A conversation with your farm</h2></div><span class="badge">'+(token?'Authenticated text console':'SMS simulator')+'</span></div><div class="two-col"><article class="phone"><div class="phone-title">◒ Terraviva <small>Field assistant</small></div><div class="messages" aria-live="polite">'+chat.map(m=>'<p class="bubble '+m.who+'">'+esc(m.text)+'</p>').join('')+'</div><form id="sms-form"><label class="sr-only" for="message">Your message</label><input id="message" maxlength="500" required placeholder="Type a message…" autocomplete="off"><button class="primary" '+(busy?'disabled':'')+'>Send</button></form></article><div><article class="card"><h3>Try the full journey</h3><div class="commands">'+['Harvested 12 tonnes of wheat from North Field','YES','SUMMARY','SHARE COOP 7','CONFIRM','ACCESS','REVOKE COOP'].map(x=>'<button class="link" data-command="'+x+'">'+x+'</button>').join('')+'</div><p class="muted">Confirmation expires after 10 minutes. Dates use UTC in this pilot. Supported language: English, using the examples above.</p></article><article class="card space"><h3>Simple messages. Clear control.</h3><p>Only your pre-approved cooperative can be granted access by SMS. Commercial permissions and new recipients need authenticated dashboard access.</p></article></div></div>';$('#sms-form').onsubmit=send;const box=$('.messages');box.scrollTop=box.scrollHeight}
if(view==='depot')c.innerHTML='<div class="section-head"><div><p class="eyebrow">YOUR CENTRAL RECORD</p><h2>My data depot</h2><p class="muted">Confirmed harvest records · '+(token?'centrally stored pilot':'local demonstration')+'</p></div><div class="actions"><button class="link" data-view="import">Import records</button><button class="link" id="analyse-records">Analyse my records ↗</button><button class="link" id="export">Export my records</button></div></div>'+records(state.records)+'<p class="muted">Harvest records are farmer declarations or imported source records, not independently verified measurements or certificates. CSV and JSON harvest imports are available in Data import; document storage and other farm-system connectors are future modules.</p>'+sensorSummary();
if(view==='import')importView.render(c);
if(view==='permissions'){const visible=Terra.project(state,'COOP');c.innerHTML='<h2>You choose what your data does</h2><div class="two-col space"><article class="card"><h3>Partner sharing</h3><p>COOP is the pre-approved cooperative in this pilot. Access covers all harvest quantities, products, dates and field names. No sales prices.</p><button class="primary" data-command="SHARE COOP 7">Start 7-day sharing request</button><button class="link" data-command="REVOKE COOP">Revoke cooperative</button><p class="muted">'+(visible?'Access is active.':'No active access.')+'</p></article><article class="card"><h3>Commercial aggregate use</h3><p>Allow harvest quantities to contribute to future paid industry reports. This choice is independent of using your depot or farmer dashboard.</p><label><input id="commercial" type="checkbox" '+(state.commercial?'checked':'')+'> Include my records in commercial aggregates</label><p class="muted">Benefits/revenue terms still need agreement before a real commercial programme. This pilot does not sell data.</p></article></div><article class="card space"><h3>Cooperative access preview</h3>'+(visible?records(visible):'<p>Access denied: no current grant.</p>')+'<p class="muted">Revocation prevents future access. It cannot retrieve previously downloaded copies.</p></article>';$('#commercial').onchange=consent}
if(view==='industry'){const report=Terra.aggregate([{...state,id:farm}]);c.innerHTML='<p class="eyebrow">COMMERCIAL MODULE · PILOT</p><h2>Insights with farmer permission</h2><div class="two-col space"><article class="card"><span class="badge warn">Report withheld</span><h3>Harvest supply overview</h3><p>At least '+report.minimum+' distinct contributing farms are required. This workspace contains one farm, so no aggregate is released.</p><p class="muted">Minimum group size is a demonstration control, not a guarantee of anonymity. A commercial launch also needs disclosure and repeated-query review.</p></article><article class="card"><h3>Planned data products</h3><p>Cooperatives: pooled supply planning.</p><p>Processors: regional production trends.</p><p>Farmers: benchmark dashboards returned to contributors.</p><p class="muted">No individual records, live marketplace, pricing or paid access is enabled.</p></article></div>'}
if(view==='activity')c.innerHTML='<h2>Your activity</h2><p class="muted">Pilot event history; not a tamper-proof compliance log.</p><div class="cards">'+(state.events.map(e=>'<article class="card"><small>'+esc(e.time)+'</small><p>'+esc(e.text)+'</p></article>').join('')||'<div class="empty">Confirm a record or change permission to see activity.</div>')+'</div>';
if(!token&&view==='industry'){
 const cohort=[18,24,31,22,27].map((volume,i)=>({id:'synthetic-'+i,commercial:true,records:[{volume}]}));
 const example=Terra.aggregate(cohort);
 c.innerHTML+='<article class="card space green"><p class="eyebrow">SEPARATE SYNTHETIC COHORT · NOT A LIVE REPORT</p><h2>What permission-based insight could look like</h2><div class="stats"><article><small>Fictional opt-in farms</small><strong>'+example.farms+'</strong></article><article><small>Illustrative pooled harvest</small><strong>'+example.volumeTonnes+' t</strong></article><article><small>Illustrative mean per farm</small><strong>'+(example.volumeTonnes/example.farms).toFixed(1)+' t</strong></article></div><p>Five invented farms demonstrate pooled supply planning. Ana’s wallet is not included. This does not change consent or release anyone’s data; the actual workspace report above remains withheld.</p></article>';
}
// Prepend only after view-specific event handlers have been installed; do not recreate their nodes.
if(!token&&isSample()&&view!=='sms')c.insertAdjacentHTML('afterbegin',showcase());
}
async function submit(text){if(busy)return;busy=true;chat.push({who:'user',text});view='sms';render();try{let result;if(token)result=await api('message',{message:text,id:crypto.randomUUID()});else result=Terra.apply(state,text,crypto.randomUUID());state=result.state;persist();chat.push({who:'bot',text:result.reply})}catch(e){chat.push({who:'bot',text:'Not saved: '+e.message})}finally{busy=false;render()}}
function send(e){e.preventDefault();const text=$('#message').value.trim();if(text)submit(text)}
async function consent(e){const desired=e.target.checked;if(busy){render();return}busy=true;try{if(token){state=(await api('consent',{enabled:desired})).state}else{state.commercial=desired;state.events.unshift({time:new Date().toISOString(),text:'Commercial aggregate participation '+(desired?'enabled':'disabled')});persist()}$('#status').textContent='Commercial preference saved.'}catch(err){$('#status').textContent=err.message}finally{busy=false;render()}}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;if(b.dataset.view){view=b.dataset.view;render()}if(b.dataset.command)submit(b.dataset.command);if(b.id==='analyse-records')analyseRecords();if(b.hasAttribute('data-refresh-depot'))refreshDepot();if(b.id==='export-sensors'&&token&&!busy)downloadJSON(TerraSensorSummary.exportHistory(state.sensors,farm),'terraviva-sensors.json');if(b.id==='export'){const u=URL.createObjectURL(new Blob([JSON.stringify({farm,records:state.records},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='terraviva-records.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}});
$('#connect').onclick=()=>{if(busy){$('#status').textContent='Wait for the current request to finish before switching depots.';return}if(token){token='';farm='Demo farm';loadBrowserWallet();chat=welcome();changedDepot();$('#connect').textContent='Connect private depot';render()}else $('#login').showModal()};
$('#cancel-login').onclick=()=>$('#login').close();
$('#login-form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;const candidate=$('#token').value;try{const data=TerraSensorSummary.validateDepot(await api('read',{},candidate));token=candidate;state=data.state;farm=data.farm;chat=[];changedDepot();$('#token').value='';$('#login').close();$('#connect').textContent='Disconnect'}catch(err){token='';$('#login-error').textContent=err.message}finally{busy=false;render()}};
render();

