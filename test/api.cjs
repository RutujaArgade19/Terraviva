const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),C=require('../public/core.js'),B=require('../lib/backend.cjs'),depot=require('../api/depot.js'),sms=require('../api/sms.js');
async function invoke(fn,body,headers={}){let result={};await fn({method:'POST',body,headers},{setHeader(){},set statusCode(v){result.status=v},end(v){result.body=v}});return result}
test('API denies unauthenticated and missing configuration requests',async()=>{const r=await invoke(depot,{action:'read'},{'content-type':'application/json'});assert.equal(r.status,401);const r2=await invoke(sms,'');assert.equal(r2.status,503)});
test('API central persistence, partner projection and signed SMS replay',async()=>{
const names=['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','DEPOT_ENCRYPTION_KEY','DEPOT_ACCESS_JSON','TWILIO_AUTH_TOKEN','TWILIO_WEBHOOK_URL','SMS_FARM_MAP_JSON'],old=Object.fromEntries(names.map(k=>[k,process.env[k]])),original=global.fetch;
const farmer='f'.repeat(40),partner='p'.repeat(40);
Object.assign(process.env,{UPSTASH_REDIS_REST_URL:'https://redis.test',UPSTASH_REDIS_REST_TOKEN:'fake',DEPOT_ENCRYPTION_KEY:'ab'.repeat(32),TWILIO_AUTH_TOKEN:'token',TWILIO_WEBHOOK_URL:'https://example.test/api/sms',SMS_FARM_MAP_JSON:JSON.stringify({'+34000000000':'farm-a'}),DEPOT_ACCESS_JSON:JSON.stringify([{tokenHash:crypto.createHash('sha256').update(farmer).digest('hex'),farm:'farm-a',role:'farmer'},{tokenHash:crypto.createHash('sha256').update(partner).digest('hex'),farm:'farm-a',role:'partner',recipient:'COOP'}])});
const db=new Map();global.fetch=async(url,opts)=>{const a=JSON.parse(opts.body);let result;if(a[0]==='GET')result=db.get(a[1])||null;else if(a[1].includes('INCR'))result=1;else {const current=db.get(a[3])||'';result=current===a[4]?1:0;if(result)db.set(a[3],a[5])}return {ok:true,json:async()=>({result})}};
try{const h={'content-type':'application/json',authorization:'Bearer '+farmer},ph={...h,authorization:'Bearer '+partner};
assert.equal((await invoke(depot,{action:'read'},ph)).status,403);
await invoke(depot,{action:'message',message:'Harvested 12 tonnes of wheat from North Field',id:'one'},h);
const p={From:'+34000000000',Body:'YES',MessageSid:'SM'+'1'.repeat(32)};
const sh={'content-type':'application/x-www-form-urlencoded','x-twilio-signature':B.signature('token',process.env.TWILIO_WEBHOOK_URL,p)};
assert.equal((await invoke(sms,p,{...sh,'x-twilio-signature':'invalid'})).status,403);
const saved=await invoke(sms,p,sh);assert.equal(saved.status,200);assert.match(saved.body,/Saved 12/);
assert.equal((await invoke(sms,p,sh)).body.includes('<Message>'),false);
const read=JSON.parse((await invoke(depot,{action:'read'},h)).body);assert.equal(read.state.records.length,1);
await invoke(depot,{action:'message',message:'SHARE COOP 7',id:'share'},h);await invoke(depot,{action:'message',message:'CONFIRM',id:'confirm'},h);
const projected=JSON.parse((await invoke(depot,{action:'read'},ph)).body);assert.equal(projected.records[0].volume,12);assert.equal(projected.state,undefined);
assert.equal((await invoke(depot,{action:'consent',enabled:true},ph)).status,403);
await invoke(depot,{action:'message',message:'REVOKE COOP',id:'revoke'},h);assert.equal((await invoke(depot,{action:'read'},ph)).status,403);
const beforeImport=JSON.parse((await invoke(depot,{action:'read'},h)).body).state;
const rows=[{id:'load-2026-1',farm:'farm-a',product:'barley',quantity:'1250',unit:'kg',field:'Peña',date:'2026-09-22'}];
const imported=JSON.parse((await invoke(depot,{action:'import',rows,sourceName:'harvest.csv',commercial:true,grants:[{recipient:'attacker'}]},h)).body);
assert.equal(imported.added,1);assert.equal(imported.state.records.length,2);assert.equal(imported.state.records[1].volume,1.25);
assert.equal(imported.state.records[1].date,'2026-09-22');assert.equal(imported.state.records[1].source,'file import • harvest.csv');
assert.equal(imported.state.records[1].importMeta.farm,'farm-a');assert.equal(imported.state.commercial,beforeImport.commercial);
assert.deepEqual(imported.state.grants,beforeImport.grants);assert.deepEqual(imported.state.processed,beforeImport.processed);
const repeated=JSON.parse((await invoke(depot,{action:'import',rows,sourceName:'harvest.csv'},h)).body);assert.equal(repeated.added,0);assert.equal(repeated.skipped,1);
assert.equal((await invoke(depot,{action:'import',rows,sourceName:'harvest.csv'},ph)).status,403);
const foreign=await invoke(depot,{action:'import',rows:[{...rows[0],farm:'other-farm'}],sourceName:'foreign.csv'},h);assert.equal(foreign.status,400);assert.ok(JSON.parse(foreign.body).issues.length);
assert.equal((await invoke(depot,{action:'import',rows:[{...rows[0],quantity:'2500'}],sourceName:'harvest.csv'},h)).status,400);
assert.equal((await invoke(depot,{action:'import',plan:{records:rows},sourceName:'forged.csv'},h)).status,400);
const afterImport=JSON.parse((await invoke(depot,{action:'read'},h)).body).state;assert.equal(afterImport.records.length,2);
assert.equal([...db.values()].some(x=>x.includes('North Field')),false);
}finally{global.fetch=original;for(const k of names)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k]}
});


