'use strict';
const fs=require('node:fs'),path=require('node:path');
const prepared=require('node:child_process').spawnSync('python3',[path.join(__dirname,'prepare-reference.py')],{stdio:'inherit'});
if(prepared.error)throw prepared.error;
if(prepared.signal)throw new Error('Reference preparation was interrupted by '+prepared.signal+'. Retry the build; no incomplete source bundle is accepted.');
if(prepared.status!==0)process.exit(prepared.status||1);
require('./build-report.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'dist');
fs.rmSync(output,{recursive:true,force:true});
fs.mkdirSync(output,{recursive:true});
fs.cpSync(path.join(root,'public'),output,{recursive:true});
console.log('Built static assets, dataset catalog and self-contained report. Vercel serves api/ as functions.');

