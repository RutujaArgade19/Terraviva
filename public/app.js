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
function welcome(){return [{who:'bot',text:'SMS simulation — no messages are sent. Your wallet has '+state.records.length+' harvest records ('+state.records.reduce((n,r)=>n+r.volume,0).toFixed(2)+' tonnes). Try SUMMARY, or record a new harvest and reply YES. Then open My farm insights to see the change.'}]}
let chat=welcome();
function persist(){if(!token)try{localStorage.setItem(browserKey,JSON.stringify(state))}catch{$('#status').textContent='Browser storage unavailable. Keep this tab open.'}}
async function api(action,extra={},accessToken=token){const r=await fetch('/api/depot',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+accessToken},body:JSON.stringify({action,...extra})});const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error||'Request failed'),{issues:data.issues,code:data.code,status:r.status});return data}
const importView=TerraImportUI.create({getContext:()=>({key:depotVersion,farm,connected:Boolean(token)}),getState:()=>state,isBusy:()=>busy,setBusy:value=>{busy=value},refresh:()=>render(),updateState:value=>{state=value;persist()},commitConnected:(rows,options)=>api('import',{rows,sourceName:options.sourceName,sourceKind:options.sourceKind}),analyseSource,status:text=>{$('#status').textContent=text}});
function sensorSummary(){
 if(!token&&isSample())return '<article class="card space"><p class="eyebrow">ILLUSTRATIVE SENSOR SNAPSHOT · NOT LIVE</p><h2>North Field & Hillside Grove</h2><p>Fictional readings for Ana’s farm. No device is connected and these values are not private-depot records.</p><div class="stats"><article><small>North Field · soil moisture</small><strong>24 <i>%</i></strong><span>12 October 2026 · 08:00 UTC</span></article><article><small>North Field · temperature</small><strong>18.6 <i>°C</i></strong><span>12 October 2026 · 08:00 UTC</span></article><article><small>Hillside Grove · rainfall</small><strong>4.2 <i>mm</i></strong><span>12 October 2026 · daily total</span></article></div><a class="link" href="/sensors.html">Explore the separate sensor simulator ↗</a></article>';
 return TerraSensorSummary.render(state.sensors,{connected:Boolean(token),farm,busy});
}
function isSample(){return state.records.some(r=>r.id==='demo-record-1'&&r.source==='illustrative farmer entry')}

// ---------- Simple farmer layout: Home + three big sections ----------
// Sub-screens live under one of the three sections so the tab bar stays at three choices.
const PARENT={sms:'add',import:'add',sensorsadd:'add',publicdata:'add',depot:'insights',industry:'insights',activity:'permissions'};
const ICON={
 add:'<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12M6 9l6-6 6 6M4 21h16"/></svg>',
 insights:'<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
 permissions:'<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5zM12 15v2"/></svg>',
 text:'<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
 file:'<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6"/></svg>',
 list:'<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1"/></svg>',
 compare:'<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 20h18M6 20v-6M11 20V8M16 20v-9M21 20V5"/></svg>',
 history:'<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 7v5l3 2M3 12a9 9 0 1 0 3-6.7M3 4v4h4"/></svg>',
 sensor:'<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 21v-7M8.5 10.5a5 5 0 0 1 7 0M5.6 7.6a9 9 0 0 1 12.8 0M12 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>',
 globe:'<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>'
};
function tile(target,icon,title,text,extra=''){return '<button class="tile'+extra+'" data-view="'+target+'">'+icon+'<strong>'+title+'</strong><span>'+text+'</span></button>'}
function back(target,label){return '<button class="back" data-view="'+target+'">← Back to '+label+'</button>'}
function day(iso){const d=new Date(iso);return Number.isNaN(d.getTime())?String(iso).slice(0,10):d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'})}
function coopGrant(){const now=Date.now();return state.grants.filter(g=>g.recipient==='COOP'&&Terra.active(g,now)).sort((a,b)=>Date.parse(b.expires)-Date.parse(a.expires))[0]||null}
function total(){return state.records.reduce((a,r)=>a+r.volume,0).toFixed(2)}
function sampleBanner(){return !token&&isSample()?'<p class="sample-banner">Ana García · Finca La Ribera, Valencia · fictional demo farm</p>':''}
function certificates(){return Array.isArray(state.certificates)?state.certificates:[]}

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
function stats(){return '<section class="stats"><article><small>Harvests saved</small><strong>'+state.records.length+'</strong><span>Confirmed by you</span></article><article><small>Total harvest</small><strong>'+total()+' <i>t</i></strong><span>All recorded dates</span></article><article><small>Partners with access</small><strong>'+state.grants.filter(g=>Terra.active(g,Date.now())).length+'</strong><span>You control access</span></article></section>'}
function records(rows){return rows.length?'<div class="table-wrap"><table><thead><tr><th>Product</th><th>Quantity</th><th>Field</th><th>Date</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.product)+'</td><td>'+esc(r.volume)+' t</td><td>'+esc(r.field)+'</td><td>'+esc(r.date)+'</td></tr>').join('')+'</tbody></table></div>':'<div class="empty">No harvests yet. Add your first one in Add my data.</div>'}

function home(){
 const g=coopGrant();
 return '<h1 class="hello">'+(!token&&isSample()?'Hello, Ana':'Hello')+'</h1>'+sampleBanner()+'<p class="lead">What would you like to do today?</p><div class="tiles">'
  +tile('add',ICON.add,'Add my data','Text a harvest or upload a file',' main')
  +tile('insights',ICON.insights,'My farm insights','Your harvests and how you compare')
  +tile('permissions',ICON.permissions,'Who sees my data','Permissions and certificates')
  +'</div><p class="summary"><span>'+state.records.length+(state.records.length===1?' harvest':' harvests')+' saved</span><span>'+total()+' tonnes in total</span><span>'+(g?'Your cooperative can see your harvests until '+esc(day(g.expires)):'Nobody else can see your data')+'</span></p>';
}
function addData(){
 return '<h1>Add my data</h1><p class="lead">Choose the easiest way for you.</p><div class="tiles two">'
  +tile('sms',ICON.text,'Send a text','For example: Harvested 2 tonnes of wheat from North Field')
  +tile('import',ICON.file,'Upload a file','A spreadsheet (CSV) or JSON file of your harvests')
  +tile('sensorsadd',ICON.sensor,'Data from my sensors','Soil, weather and water readings from your fields')
  +tile('publicdata',ICON.globe,'My public data','Weather, soil and crop statistics already published about your area')
  +'</div>';
}
// ---------- Insights: a plain-language summary of the farmer's own records ----------
function sum(rows){return rows.reduce((a,r)=>a+r.volume,0)}
function briefAnalysis(){
 const rows=state.records;if(!rows.length)return '';
 const by=key=>{const m=new Map();for(const r of rows)m.set(r[key],(m.get(r[key])||0)+r.volume);return [...m.entries()].sort((a,b)=>b[1]-a[1])};
 const all=sum(rows),[crop,cropT]=by('product')[0],[field,fieldT]=by('field')[0];
 const latest=[...rows].sort((a,b)=>String(b.date).localeCompare(String(a.date)))[0];
 const points=[
  ['Main crop','<strong class="crop-name">'+esc(crop)+'</strong>: '+cropT.toFixed(2)+' t, '+Math.round(100*cropT/all)+'% of everything you recorded'],
  ['Best field','<strong>'+esc(field)+'</strong> gave the most: '+fieldT.toFixed(2)+' t'],
  ['Average harvest',(all/rows.length).toFixed(2)+' t each time, over '+rows.length+(rows.length===1?' harvest':' harvests')],
  ['Last harvest',esc(day(latest.date))+' · '+esc(latest.volume)+' t of '+esc(latest.product)+' from '+esc(latest.field)]
 ];
 return '<article class="card space"><h2>Your farm in brief</h2><dl class="brief">'+points.map(([k,v])=>'<div><dt>'+k+'</dt><dd>'+v+'</dd></div>').join('')+'</dl><p class="muted">Worked out from your own records only. Nobody else’s data is used here.</p></article>';
}
// Fixed, invented cohort for the browser demo only. Seeded so the mock-up is identical on every visit.
const MOCK_FARMS=120,TOP_SHARE=0.05;
function mockCohort(){
 let seed=2026;const rand=()=>{seed=(seed+0x6D2B79F5)|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296};
 const normal=(m,sd)=>m+sd*Math.sqrt(-2*Math.log(1-rand()))*Math.cos(2*Math.PI*rand());
 return Array.from({length:MOCK_FARMS},()=>{const wheat=Math.max(2,normal(15,5)),olives=Math.max(0.5,normal(4.5,1.8));return {wheat,olives,total:wheat+olives,harvests:Math.max(1,Math.round(normal(4,1.5)))}});
}
function topFarms(){
 const farms=mockCohort().sort((a,b)=>b.total-a.total),n=Math.ceil(farms.length*TOP_SHARE);
 if(n<5)return null; // same minimum-group rule as the aggregate core
 const avg=(rows,k)=>rows.reduce((a,f)=>a+f[k],0)/rows.length,med=k=>{const v=farms.map(f=>f[k]).sort((a,b)=>a-b),lo=Math.floor((v.length-1)/2),hi=Math.ceil((v.length-1)/2);return (v[lo]+v[hi])/2};
 const top=farms.slice(0,n);
 return {n,count:farms.length,top:{total:avg(top,'total'),wheat:avg(top,'wheat'),olives:avg(top,'olives'),harvests:avg(top,'harvests')},typical:{total:med('total'),wheat:med('wheat'),olives:med('olives'),harvests:med('harvests')}};
}
function topPercentMock(){
 if(token)return '';
 const m=topFarms();if(!m)return '';
 const mine={total:sum(state.records),wheat:sum(state.records.filter(r=>r.product==='wheat')),olives:sum(state.records.filter(r=>r.product==='olives')),harvests:state.records.length};
 const max=Math.max(mine.total,m.top.total,m.typical.total);
 const bar=(label,v,cls)=>'<div class="crop-row compare '+cls+'"><span>'+label+'</span><progress max="'+max.toFixed(2)+'" value="'+v.toFixed(2)+'">'+v.toFixed(1)+' t</progress><strong>'+v.toFixed(1)+' t</strong></div>';
 const row=(label,k,unit)=>'<tr><td>'+label+'</td><td>'+mine[k].toFixed(unit?1:0)+unit+'</td><td>'+m.typical[k].toFixed(unit?1:0)+unit+'</td><td>'+m.top[k].toFixed(unit?1:0)+unit+'</td></tr>';
 return '<article class="card space mock"><p class="eyebrow">ILLUSTRATIVE MOCK-UP · INVENTED FARMS, NOT REAL DATA</p><h2>How the top 5% of similar farms do</h2>'
  +'<p>'+m.count+' invented wheat and olive farms like yours. The top 5% are the '+m.n+' farms with the largest total harvest this season.</p>'
  +'<h3>Total harvest this season</h3>'+bar('You',mine.total,'you')+bar('Typical farm',m.typical.total,'typical')+bar('Top 5%',m.top.total,'top')
  +'<div class="table-wrap space"><table><thead><tr><th>Per farm</th><th>You</th><th>Typical farm</th><th>Top 5% average</th></tr></thead><tbody>'+row('Wheat','wheat',' t')+row('Olives','olives',' t')+row('Harvests recorded','harvests','')+'</tbody></table></div>'
  +'<p class="muted">The top group is shown only because it has at least 5 farms. A real version would compare harvest per hectare, use only farms that chose to take part, and explain what the top farms do differently.</p></article>';
}
function sensorsAdd(){
 return back('add','Add my data')+'<h1>Data from my sensors</h1><p class="lead">Readings from sensors in your fields arrive here by themselves. You do not need to type them.</p>'
  +'<article class="card"><h2>How it works</h2><ol class="steps"><li>Your sensor provider or advisor connects the sensor to Terraviva.</li><li>Readings arrive automatically, marked with the field and the time.</li><li>Only you can see them, unless you choose to share.</li></ol>'
  +'<a class="link" href="/sensors.html">Open the sensor simulator ↗</a></article>'+sensorSummary();
}
function publicData(){
 const card=(title,text)=>'<article class="card public-card"><h2>'+title+'</h2><p class="big-text">'+text+'</p><span class="pill off">Coming soon</span></article>';
 return back('add','Add my data')+'<h1>My public data</h1><p class="lead">Information already published about your area, from open sources. Nothing is added to your farm records unless you say yes.</p>'
  +'<div class="public-grid">'+card('Weather for my area','Rainfall, temperature and frost days near your fields.')+card('Soil of my region','Soil type and organic matter for your area.')+card('Crop statistics','Average yields of your crops in your region.')+'</div>'
  +'<article class="card space"><h3>See the data now</h3><p>The hackathon’s reference crop, soil and weather tables can already be browsed. They are not linked to your farm.</p><a class="link" href="/reference-data.html">Browse public reference data ↗</a></article>';
}
function insights(){
 const grouped=new Map();for(const r of state.records)grouped.set(r.product,(grouped.get(r.product)||0)+r.volume);
 const max=Math.max(1,...grouped.values());
 const crops=[...grouped.entries()].sort((a,b)=>b[1]-a[1]).map(([p,n])=>'<div class="crop-row"><span class="crop-name">'+esc(p)+'</span><progress max="'+max.toFixed(2)+'" value="'+n.toFixed(2)+'">'+n.toFixed(2)+' t</progress><strong>'+n.toFixed(2)+' t</strong></div>').join('');
 return '<h1>My farm insights</h1><p class="lead">Everything you have recorded, in one place.</p>'+stats()
  +'<article class="card"><h2>Your harvest by crop</h2>'+(crops||'<p class="muted">Your insights fill in automatically when you add a harvest.</p>')+'</article>'
  +briefAnalysis()+topPercentMock()
  +'<div class="tiles two space">'
  +tile('depot',ICON.list,'All my records','See, download or analyse every harvest')
  +tile('industry',ICON.compare,'Compare with other farms','How farms like yours are doing')
  +'</div>'+sensorSummary();
}
function permissions(){
 const g=coopGrant(),visible=Terra.project(state,'COOP'),certs=certificates(),today=new Date().toISOString().slice(0,10);
 const list=certs.length?'<ul class="cert-list">'+certs.map(c=>{const valid=!c.until||c.until>=today;return '<li><div><strong>'+esc(c.name)+'</strong><span>'+(c.issuer?esc(c.issuer)+' · ':'')+(c.until?'valid until '+esc(day(c.until)):'no end date')+'</span></div><span class="pill '+(valid?'on':'off')+'">'+(valid?'Valid':'Expired')+'</span><button class="link" data-remove-cert="'+esc(c.id)+'">Remove</button></li>'}).join('')+'</ul>':'<div class="empty">No certificates yet. Add one so partners can ask to see it.</div>';
 const form=token?'<p class="muted">Saving certificates to the private depot is not available yet in this pilot.</p>':'<form id="cert-form" class="cert-form"><label>Certificate name<input id="cert-name" required maxlength="80" placeholder="e.g. Organic farming" autocomplete="off"></label><label>Issued by<input id="cert-issuer" maxlength="80" placeholder="Certification body" autocomplete="off"></label><label>Valid until<input id="cert-until" type="date"></label><button class="primary big">Add certificate</button></form>';
 return '<h1>Who sees my data</h1><p class="lead">You decide. You can change your mind at any time.</p>'
  +'<article class="card partner"><div class="partner-head"><h2>Your cooperative</h2><span class="pill '+(visible?'on':'off')+'">'+(visible?'Access is active':'No access')+'</span></div>'
  +'<p class="big-text">'+(g?'Can see your harvest products, amounts, fields and dates until <strong>'+esc(day(g.expires))+'</strong>. Never your prices.':'Cannot see any of your data right now.')+'</p>'
  +'<div class="big-actions">'+(visible?'<button class="big danger" id="stop-coop"'+(busy?' disabled':'')+'>Stop sharing</button>':'<button class="big primary" id="share-coop"'+(busy?' disabled':'')+'>Share for 7 days</button>')+'</div>'
  +'<details><summary>What the cooperative can see</summary>'+(visible?records(visible):'<p>Access denied: no current grant.</p>')+'</details>'
  +'<p class="muted">Stopping prevents future access. It cannot retrieve copies already downloaded.</p></article>'
  +'<article class="card space"><h2>Anonymous industry reports</h2><p class="big-text">Let your harvest amounts be counted, without your name, in reports for buyers and processors.</p><label class="switch"><input id="commercial" type="checkbox" '+(state.commercial?'checked':'')+'> <span>'+(state.commercial?'Yes, include my farm':'No, keep my farm out')+'</span></label><p class="muted">Off unless you turn it on. This pilot does not sell data.</p></article>'
  +'<article class="card space"><h2>My certificates</h2><p class="muted">Keep your certificates in one place. Terraviva does not check them, so partners may still ask for the original.</p>'+list+form+'</article>'
  +'<div class="tiles two space">'+tile('activity',ICON.history,'History','Every share and change you made',' slim')+'</div>';
}

function render(){
const tab=PARENT[view]||view;
document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===tab));
$('#identity').textContent=farm;
$('#refresh-depot').hidden=!token;$('#refresh-depot').disabled=busy;
$('#mode').textContent=token?'Connected pilot depot · Stored centrally. This text panel sends authenticated requests; live SMS requires provider setup.':'Browser demo · '+(isSample()?'Ana García · Fictional sample wallet · ':'')+'Your changes stay on this device. SMS is simulated; no messages are sent.';
const c=$('#content');
if(view==='overview')c.innerHTML=home();
if(view==='add')c.innerHTML=addData();
if(view==='insights')c.innerHTML=insights();
if(view==='sensorsadd')c.innerHTML=sensorsAdd();
if(view==='publicdata')c.innerHTML=publicData();
if(view==='sms'){c.innerHTML=back('add','Add my data')+'<h1>Send a text</h1><p class="lead">Write what you harvested, then reply YES to save it.</p><div class="two-col"><article class="phone"><div class="phone-title">◒ Terraviva <small>Field assistant · '+(token?'authenticated':'simulated')+'</small></div><div class="messages" aria-live="polite">'+chat.map(m=>'<p class="bubble '+m.who+'">'+esc(m.text)+'</p>').join('')+'</div><form id="sms-form"><label class="sr-only" for="message">Your message</label><input id="message" maxlength="500" required placeholder="Type a message…" autocomplete="off"><button class="primary" '+(busy?'disabled':'')+'>Send</button></form></article><div><article class="card"><h3>Tap an example</h3><div class="commands">'+['Harvested 12 tonnes of wheat from North Field','YES','SUMMARY','SHARE COOP 7','CONFIRM','ACCESS','REVOKE COOP'].map(x=>'<button class="link" data-command="'+x+'">'+x+'</button>').join('')+'</div><p class="muted">Confirmation expires after 10 minutes. Dates use UTC in this pilot. Supported language: English, using the examples above.</p></article><article class="card space"><p class="eyebrow">JURY DEMO · OPTIONAL REAL SEND</p><p>The conversation here is simulated. A guarded real send uses a presenter-only confirmation, a fixed recipient and a strict daily limit.</p><a class="link" href="/live-sms.html">Open guarded live SMS →</a></article></div></div>';$('#sms-form').onsubmit=send;const box=$('.messages');box.scrollTop=box.scrollHeight}
if(view==='import'){importView.render(c);c.insertAdjacentHTML('afterbegin',back('add','Add my data'))}
if(view==='depot')c.innerHTML=back('insights','My farm insights')+'<div class="section-head"><div><h1>All my records</h1><p class="muted">Confirmed harvest records · '+(token?'centrally stored pilot':'local demonstration')+'</p></div><div class="actions"><button class="link" id="analyse-records">Analyse my records ↗</button><button class="link" id="export">Download my records</button></div></div>'+records(state.records)+'<p class="muted">Harvest records are farmer declarations or imported source records, not independently verified measurements or certificates.</p>'+sensorSummary();
if(view==='permissions'){c.innerHTML=permissions();$('#commercial').onchange=consent;if(!token)$('#cert-form').onsubmit=addCertificate}
if(view==='industry'){const report=Terra.aggregate([{...state,id:farm}]);c.innerHTML=back('insights','My farm insights')+'<h1>Compare with other farms</h1><div class="two-col space"><article class="card"><span class="badge warn">Report withheld</span><h3>Harvest supply overview</h3><p>At least '+report.minimum+' distinct contributing farms are required. This workspace contains one farm, so no aggregate is released.</p><p class="muted">Minimum group size is a demonstration control, not a guarantee of anonymity. A commercial launch also needs disclosure and repeated-query review.</p></article><article class="card"><h3>Planned data products</h3><p>Cooperatives: pooled supply planning.</p><p>Processors: regional production trends.</p><p>Farmers: benchmark dashboards returned to contributors.</p><p class="muted">No individual records, live marketplace, pricing or paid access is enabled.</p></article></div>'}
if(view==='activity')c.innerHTML=back('permissions','Who sees my data')+'<h1>History</h1><p class="muted">Pilot event history; not a tamper-proof compliance log.</p><div class="cards">'+(state.events.map(e=>'<article class="card"><small>'+esc(e.time)+'</small><p>'+esc(e.text)+'</p></article>').join('')||'<div class="empty">Confirm a record or change permission to see activity.</div>')+'</div>';
if(!token&&view==='industry'){
 const cohort=[18,24,31,22,27].map((volume,i)=>({id:'synthetic-'+i,commercial:true,records:[{volume}]}));
 const example=Terra.aggregate(cohort);
 c.innerHTML+='<article class="card space green"><p class="eyebrow">SEPARATE SYNTHETIC COHORT · NOT A LIVE REPORT</p><h2>What permission-based insight could look like</h2><div class="stats"><article><small>Fictional opt-in farms</small><strong>'+example.farms+'</strong></article><article><small>Illustrative pooled harvest</small><strong>'+example.volumeTonnes+' t</strong></article><article><small>Illustrative mean per farm</small><strong>'+(example.volumeTonnes/example.farms).toFixed(1)+' t</strong></article></div><p>Five invented farms demonstrate pooled supply planning. Ana’s wallet is not included. This does not change consent or release anyone’s data; the actual workspace report above remains withheld.</p></article>';
}
}
async function submit(text,options={}){if(busy)return;busy=true;chat.push({who:'user',text});if(!options.stay)view='sms';render();try{let result;if(token)result=await api('message',{message:text,id:crypto.randomUUID()});else result=Terra.apply(state,text,crypto.randomUUID());state=result.state;persist();chat.push({who:'bot',text:result.reply});if(options.stay)$('#status').textContent=result.reply}catch(e){chat.push({who:'bot',text:'Not saved: '+e.message});if(options.stay)$('#status').textContent='Not saved: '+e.message}finally{busy=false;render()}}
// One tap on the permissions screen runs the same two-step SMS flow (request, then confirm).
async function shareCoop(){await submit('SHARE COOP 7',{stay:true});if(token||state.pending?.kind==='share')await submit('CONFIRM',{stay:true})}
function send(e){e.preventDefault();const text=$('#message').value.trim();if(text)submit(text)}
async function consent(e){const desired=e.target.checked;if(busy){render();return}busy=true;try{if(token){state=(await api('consent',{enabled:desired})).state}else{state.commercial=desired;state.events.unshift({time:new Date().toISOString(),text:'Commercial aggregate participation '+(desired?'enabled':'disabled')});persist()}$('#status').textContent='Your choice is saved.'}catch(err){$('#status').textContent=err.message}finally{busy=false;render()}}
// Certificates are farmer-declared notes kept in the browser wallet; the pilot depot API does not store them yet.
function addCertificate(e){e.preventDefault();if(token||busy)return;const name=$('#cert-name').value.trim();if(!name)return;
 const issuer=$('#cert-issuer').value.trim().slice(0,80),until=/^\d{4}-\d{2}-\d{2}$/.test($('#cert-until').value)?$('#cert-until').value:'';
 state.certificates=[...certificates(),{id:crypto.randomUUID(),name:name.slice(0,80),issuer,until}];
 state.events.unshift({time:new Date().toISOString(),text:'Certificate added: '+name.slice(0,80)});persist();$('#status').textContent='Certificate added.';render()}
function removeCertificate(id){if(token||busy)return;const cert=certificates().find(c=>c.id===id);if(!cert)return;
 state.certificates=certificates().filter(c=>c.id!==id);state.events.unshift({time:new Date().toISOString(),text:'Certificate removed: '+cert.name});persist();$('#status').textContent='Certificate removed.';render()}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;if(b.dataset.view){view=b.dataset.view;$('#status').textContent='';render()}if(b.dataset.command)submit(b.dataset.command);if(b.id==='share-coop')shareCoop();if(b.id==='stop-coop')submit('REVOKE COOP',{stay:true});if(b.dataset.removeCert)removeCertificate(b.dataset.removeCert);if(b.id==='analyse-records')analyseRecords();if(b.hasAttribute('data-refresh-depot'))refreshDepot();if(b.id==='export-sensors'&&token&&!busy)downloadJSON(TerraSensorSummary.exportHistory(state.sensors,farm),'terraviva-sensors.json');if(b.id==='export'){const u=URL.createObjectURL(new Blob([JSON.stringify({farm,records:state.records},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='terraviva-records.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}});
$('#connect').onclick=()=>{if(busy){$('#status').textContent='Wait for the current request to finish before switching depots.';return}if(token){token='';farm='Demo farm';loadBrowserWallet();chat=welcome();changedDepot();$('#connect').textContent='Connect private depot';render()}else $('#login').showModal()};
// Demo only: shows the planned language choice without translating the page yet.
$('#language').onchange=e=>{const name={es:'Español',fr:'Français',it:'Italiano',de:'Deutsch',pl:'Polski',nl:'Nederlands'}[e.target.value];if(name)$('#status').textContent=name+' is coming soon. This demo is in English for now.';e.target.value='en'};
$('#cancel-login').onclick=()=>$('#login').close();
$('#login-form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;const candidate=$('#token').value;try{const data=TerraSensorSummary.validateDepot(await api('read',{},candidate));token=candidate;state=data.state;farm=data.farm;chat=[];changedDepot();$('#token').value='';$('#login').close();$('#connect').textContent='Disconnect'}catch(err){token='';$('#login-error').textContent=err.message}finally{busy=false;render()}};
render();
