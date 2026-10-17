'use strict';
const fs=require('node:fs'),path=require('node:path');
require('./build-report.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'dist');
fs.rmSync(output,{recursive:true,force:true});
fs.mkdirSync(output,{recursive:true});
fs.cpSync(path.join(root,'public'),output,{recursive:true});
console.log('Built static assets, dataset catalog and self-contained report. Vercel serves api/ as functions.');

