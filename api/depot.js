const B=require('../lib/backend.cjs'),Core=require('../public/core.js');
module.exports=async(req,res)=>{try{
if(req.method!=='POST')throw B.fail(405,'Use POST.');
if(!String(req.headers['content-type']||'').startsWith('application/json'))throw B.fail(415,'Use application/json.');
const identity=B.auth(req.headers.authorization);B.config();await B.rate(identity.farm);
let data=await B.body(req);if(typeof data==='string'){try{data=JSON.parse(data)}catch{throw B.fail(400,'Invalid JSON.')}}
if(!data||typeof data!=='object')throw B.fail(400,'Invalid request.');
if(identity.role==='partner'){if(data.action!=='read')throw B.fail(403,'Read access only.');const records=Core.project(await B.read(identity.farm),identity.recipient);if(records===null)throw B.fail(403,'No active grant.');return B.send(res,200,{records})}
if(identity.role!=='farmer')throw B.fail(403,'Farmer access required.');
if(data.action==='read'){const s=await B.read(identity.farm);return B.send(res,200,{farm:identity.farm,state:s})}
if(data.action==='message'){if(typeof data.message!=='string'||data.message.length>500||!/^[-a-zA-Z0-9]{1,100}$/.test(data.id||''))throw B.fail(400,'Invalid message or request ID.');
const result=await B.change(identity.farm,s=>Core.apply(s,data.message,'web-'+data.id));return B.send(res,200,result)}
if(data.action==='consent'){if(typeof data.enabled!=='boolean')throw B.fail(400,'Boolean choice required.');const result=await B.change(identity.farm,s=>{s.commercial=data.enabled;s.events.unshift({time:new Date().toISOString(),text:'Commercial aggregate participation '+(data.enabled?'enabled':'disabled')});return {state:s}});return B.send(res,200,result)}
throw B.fail(400,'Unknown action.');
}catch(e){B.error(res,e)}};
