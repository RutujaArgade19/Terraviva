(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.Terra=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const allowed=['product','volume','date','field'];
function initial(){return {records:[],grants:[],commercial:false,pending:null,processed:{},events:[]}}
function active(g,now){return !g.revoked&&Date.parse(g.expires)>now}
function event(s,text,now){s.events.unshift({text,time:new Date(now).toISOString()})}
function apply(state,message,id,now=Date.now()){
const s=structuredClone(state);if(Object.hasOwn(s.processed,id))return {state:s,reply:s.processed[id],duplicate:true};
let reply;const text=String(message).trim(),upper=text.toUpperCase();
if(text.length>500)reply='Message too long. Send HELP for examples.';
else if(upper==='HELP')reply='Try: Harvested 12 tonnes of wheat from North Field; SUMMARY; ACCESS; SHARE COOP 7; REVOKE COOP; CANCEL.';
else if(upper==='CANCEL'){s.pending=null;reply='Pending action cancelled.'}
else if(upper==='YES'||upper==='CONFIRM'){
const p=s.pending;s.pending=null;
if(!p||p.expires<=now)reply='No current confirmation. Please send the request again.';
else if(p.kind==='harvest'){s.records.push({...p.record,id:'record-'+id,source:'farmer-confirmed SMS'});event(s,'Harvest confirmed: '+p.record.volume+' t '+p.record.product,now);reply='Saved '+p.record.volume+' tonnes of '+p.record.product+' from '+p.record.field+'. Commercial use remains '+(s.commercial?'enabled':'off')+'.'}
else {s.grants.push({id:'grant-'+id,recipient:'COOP',fields:[...allowed],purpose:'Harvest coordination',expires:new Date(now+p.days*86400000).toISOString(),revoked:false});event(s,'Granted COOP harvest access for '+p.days+' days',now);reply='COOP can access harvest records for '+p.days+' days. Prices excluded. Send REVOKE COOP to revoke.'}
}
else if(upper==='ACCESS'){const gs=s.grants.filter(g=>active(g,now));reply=gs.length?gs.map(g=>g.recipient+': harvest records until '+g.expires.slice(0,10)).join('; '):'No active partner access.'}
else if(upper==='REVOKE COOP'){s.grants.filter(g=>g.recipient==='COOP').forEach(g=>g.revoked=true);if(s.pending?.kind==='share')s.pending=null;event(s,'Revoked COOP access',now);reply='COOP access revoked. Previously exported copies cannot be recalled.'}
else if(upper==='SUMMARY'){reply=s.records.length+' harvest records; '+s.records.reduce((n,r)=>n+r.volume,0).toFixed(2)+' tonnes recorded. Commercial contribution '+(s.commercial?'on':'off')+'.'}
else if(/^SHARE COOP\s+\d+$/i.test(text)){const days=Number(text.split(/\s+/).pop());if(days<1||days>30)reply='Choose 1 to 30 days.';else{s.pending={kind:'share',days,expires:now+600000};reply='Share all harvest products, quantities, fields and dates with your pre-approved COOP for '+days+' days? Reply CONFIRM within 10 minutes. Prices excluded.'}}
else if(/commercial|sell my|share/i.test(text))reply='Use the authenticated dashboard to manage commercial use or new recipients. SMS sharing supports pre-approved COOP only.';
else {
const m=text.match(/^(?:harvested|harvest)\s+(\d+(?:[.,]\d+)?)\s*(tonnes?|tons?|t|kg)\s+(?:of\s+)?([a-zA-Z ]{2,40}?)\s+from\s+([a-zA-Z0-9 -]{2,60})$/i);
if(m){const volume=Number(m[1].replace(',','.'))*(m[2].toLowerCase()==='kg'?0.001:1);if(!Number.isFinite(volume)||volume<=0||volume>100000)reply='Please give a quantity above zero and at most 100000 tonnes.';else{s.pending={kind:'harvest',expires:now+600000,record:{product:m[3].trim().toLowerCase(),volume,field:m[4].trim(),date:new Date(now).toISOString().slice(0,10)}};reply='Record '+volume+' tonnes of '+m[3].trim().toLowerCase()+', '+m[4].trim()+', today? Reply YES within 10 minutes or CANCEL.'}}
else reply='I could not interpret that. Try: Harvested 12 tonnes of wheat from North Field. Send HELP for commands.';
}
s.processed[id]=reply;return {state:s,reply,duplicate:false}
}
function project(state,recipient,now=Date.now()){
const gs=state.grants.filter(g=>g.recipient===recipient&&active(g,now));if(!gs.length)return null;
const keys=[...new Set(gs.flatMap(g=>g.fields))].filter(k=>allowed.includes(k));
return state.records.map(r=>Object.fromEntries(keys.map(k=>[k,r[k]])))
}
function aggregate(farms,min=5){
const eligible=farms.filter(f=>f.commercial&&f.records.length);
const unique=new Map(eligible.map(f=>[f.id,f]));if(unique.size<min)return {suppressed:true,minimum:min};
return {suppressed:false,farms:unique.size,volumeTonnes:[...unique.values()].reduce((n,f)=>n+f.records.reduce((a,r)=>a+r.volume,0),0)}
}
return {initial,apply,active,project,aggregate};
});
