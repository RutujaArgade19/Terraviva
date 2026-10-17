'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
let initial=null;
const initialPath=path.join(root,'report/initial-dataset.json');
if(fs.existsSync(initialPath))initial=JSON.parse(read('report/initial-dataset.json'));
const parts={__REPORT_CSS__:read('report/style.css'),__INITIAL_DATASET__:JSON.stringify(initial).replace(/</g,'\\u003c'),__EDA_ENGINE__:read('public/eda-engine.js'),__REPORT_UI__:read('report/ui.js')};
let html=read('report/template.html');
for(const [marker,value] of Object.entries(parts))html=html.replace(marker,()=>value);
if(/__(?:REPORT_CSS|INITIAL_DATASET|EDA_ENGINE|REPORT_UI)__/.test(html))throw Error('Report template contains an unresolved required marker.');
fs.writeFileSync(path.join(root,'public/data-report.html'),html);
// Permit the exact inline blocks without enabling unsafe-inline for the app.
const hash=value=>"'sha256-"+crypto.createHash('sha256').update(value).digest('base64')+"'";
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>hash(m[1]));
const styles=[...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(m=>hash(m[1]));
const config=JSON.parse(read('vercel.json'));
for(const rule of config.headers||[])for(const header of rule.headers||[])if(header.key.toLowerCase()==='content-security-policy'){
header.value="default-src 'self'; script-src 'self' "+scripts.join(' ')+"; style-src 'self' "+styles.join(' ')+"; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
}
fs.writeFileSync(path.join(root,'vercel.json'),JSON.stringify(config,null,2)+'\n');
console.log('Built data-report.html with exact script and stylesheet CSP hashes.');
