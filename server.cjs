'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const routes={'/api/depot':require('./api/depot.js'),'/api/sms':require('./api/sms.js'),'/api/sensors':require('./api/sensors.js')};
const publicRoot=path.join(__dirname,'public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.csv':'text/csv; charset=utf-8','.tsv':'text/tab-separated-values; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.txt':'text/plain; charset=utf-8','.gz':'application/gzip'};
http.createServer((req,res)=>{
let route;try{route=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch{res.writeHead(400);return res.end('Invalid URL')}
if(routes[route])return routes[route](req,res);
if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end('Use GET or HEAD')}
const candidate=path.resolve(publicRoot,'.'+(route==='/'?'/index.html':route));
let file;try{file=fs.realpathSync(candidate)}catch{res.writeHead(404);return res.end('Not found')}
if(!file.startsWith(publicRoot+path.sep)||!fs.statSync(file).isFile()||!types[path.extname(file)]){res.writeHead(404);return res.end('Not found')}
res.setHeader('Content-Type',types[path.extname(file)]);res.setHeader('X-Content-Type-Options','nosniff');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'vercel.json'),'utf8'));
for(const header of config.headers?.find(rule=>rule.source==='/(.*)')?.headers||[])res.setHeader(header.key,header.value);
if(path.extname(file)==='.gz')res.setHeader('Cache-Control','public, max-age=0, must-revalidate, no-transform');
if(req.method==='HEAD')return res.end();
fs.createReadStream(file).on('error',()=>{if(!res.headersSent)res.writeHead(500);res.end()}).pipe(res);
}).listen(process.env.PORT||3000,'127.0.0.1',()=>console.log('Terraviva: http://127.0.0.1:'+(process.env.PORT||3000)));

