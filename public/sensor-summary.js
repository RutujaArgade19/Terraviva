(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./sensor-core.js'));
  else root.TerraSensorSummary=factory(root.SensorCore);
})(typeof globalThis!=='undefined'?globalThis:this,function(core){
'use strict';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=value=>String(value).replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
const flags={ok:'OK · source flag',unverified:'Unverified',suspect:'Suspect',invalid:'Invalid'};
const fields=['id','deviceId','field','observedAt','measurement','value','unit','quality','receivedAt'];
const link='<a class="link" href="/sensors.html">Open sensor workspace ↗</a>';

function readingsFrom(sensors){
  const readings=core.snapshot(sensors).readings;
  for(const row of readings){
    if(!row||fields.some(key=>typeof row[key]!=='string')||!core.validTimestamp(row.observedAt)||!core.validTimestamp(row.receivedAt)||!Object.hasOwn(flags,row.quality)||core.MEASUREMENTS[row.measurement]!==row.unit)throw Error('The depot returned unsupported sensor data.');
  }
  return readings;
}
function validateDepot(data,expectedFarm){
  if(!data||typeof data.farm!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(data.farm)||!data.state||['records','grants','events'].some(key=>!Array.isArray(data.state[key])))throw Error('This dashboard requires a farmer token. Partner tokens use the scoped API.');
  if(expectedFarm!==undefined&&data.farm!==expectedFarm)throw Error('The farm identity changed during refresh. Disconnect and reconnect before continuing.');
  readingsFrom(data.state.sensors);
  return data;
}
function summarize(sensors){
  const readings=readingsFrom(sensors),latest=new Map(),devices=new Set();
  let lastReceived=null,review=0;
  for(const row of readings){
    devices.add(row.deviceId);
    if(row.quality==='suspect'||row.quality==='invalid')review++;
    if(lastReceived===null||Date.parse(row.receivedAt)>Date.parse(lastReceived))lastReceived=row.receivedAt;
    const key=JSON.stringify([row.deviceId,row.field,row.measurement,row.unit]),previous=latest.get(key);
    if(!previous||Date.parse(row.observedAt)>Date.parse(previous.observedAt)||(Date.parse(row.observedAt)===Date.parse(previous.observedAt)&&Date.parse(row.receivedAt)>Date.parse(previous.receivedAt)))latest.set(key,row);
  }
  return {total:readings.length,devices:devices.size,lastReceived,review,latest:[...latest.values()].sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)||Date.parse(b.receivedAt)-Date.parse(a.receivedAt))};
}
function exportHistory(sensors,farm,now=Date.now()){
  return {kind:'private-sensor-data',farm,exportedAt:new Date(now).toISOString(),commercialUse:'not-enabled-by-this-module',readings:readingsFrom(sensors).map(row=>Object.fromEntries(fields.map(key=>[key,row[key]])))};
}
function render(sensors,{connected=false,farm='',busy=false}={}){
  const heading='<p class="eyebrow">CONNECTED FIELD DATA</p><h2>Your farm’s sensors</h2>';
  if(!connected)return '<article class="card space sensor-summary">'+heading+'<p>Keep measurements from your devices alongside your farm records.</p><p class="muted">Connect your private depot to see collected readings here. The separate sensor demo stays in its own tab; no sensor is connected to this browser demo.</p>'+link+'</article>';
  let summary;try{summary=summarize(sensors)}catch{return '<article class="card space sensor-summary">'+heading+'<p>Sensor history could not be read. Refresh your depot or open the sensor workspace.</p>'+link+'</article>'}
  const disabled=busy?' disabled':'';
  let content='<article class="card space sensor-summary">'+heading+'<p class="muted">Sensor history for '+esc(farm)+'. This is a snapshot: refresh your depot to load newly received readings.</p><div class="sensor-summary-stats"><div><strong>'+summary.total.toLocaleString('en-GB')+'</strong><span>Stored readings</span></div><div><strong>'+summary.devices.toLocaleString('en-GB')+'</strong><span>Devices with readings</span></div><div><strong>'+summary.review.toLocaleString('en-GB')+'</strong><span>Flagged by the source</span></div></div>';
  if(summary.total){
    content+='<p class="muted">Most recent receipt: <time datetime="'+esc(summary.lastReceived)+'">'+esc(summary.lastReceived)+'</time></p><h3>Latest observation per device and measurement</h3><div class="table-wrap"><table><thead><tr><th>Device / field</th><th>Measurement</th><th>Value</th><th>Measured at</th><th>Source quality</th></tr></thead><tbody>'+summary.latest.slice(0,6).map(row=>'<tr><td>'+esc(row.deviceId)+'<small>'+esc(row.field)+'</small></td><td>'+esc(label(row.measurement))+'</td><td>'+esc(row.value)+' '+esc(row.unit)+'</td><td><time datetime="'+esc(row.observedAt)+'">'+esc(row.observedAt)+'</time></td><td>'+esc(flags[row.quality])+'</td></tr>').join('')+'</tbody></table></div><p class="muted">Showing '+Math.min(6,summary.latest.length)+' of '+summary.latest.length+' device / field / measurement groups. Values retain their source units; quality flags are not farmer approval.</p>';
  }else content+='<p>No sensor readings have arrived for this farm yet. Enrol a device or gateway and configure it to send observations to your depot.</p>';
  content+='<div class="actions"><button class="link" data-refresh-depot'+disabled+'>Refresh depot</button>'+link+(summary.total?'<button class="link" id="export-sensors"'+disabled+'>Export sensor history</button>':'')+'</div><p class="muted">These readings belong to your private depot. Sensor partner sharing and commercial aggregation are not enabled in this pilot.</p></article>';
  return content;
}
return {readingsFrom,validateDepot,summarize,render,exportHistory};
});
