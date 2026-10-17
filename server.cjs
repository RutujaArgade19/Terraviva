const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const routes={'/api/depot':require('./api/depot.js'),'/api/sms':require('./api/sms.js')};
const publicFiles={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/core.js':'core.js','/style.css':'style.css'};
http.createServer((req,res)=>{const route=new URL(req.url,'http://localhost').pathname;if(routes[route])return routes[route](req,res);
const file=publicFiles[route];if(!file){res.writeHead(404);return res.end('Not found')}
res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.setHeader('X-Content-Type-Options','nosniff');fs.createReadStream(path.join(__dirname,'public',file)).pipe(res);
}).listen(process.env.PORT||3000,'127.0.0.1',()=>console.log('Terraviva: http://127.0.0.1:'+(process.env.PORT||3000)));
