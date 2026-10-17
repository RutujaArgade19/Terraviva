'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const B=require('../lib/backend.cjs');
const I=require('../public/harvest-import.js');
const stream=chunks=>({async *[Symbol.asyncIterator](){for(const chunk of chunks)yield chunk}});

test('raw request preserves a UTF-8 character split across incoming buffers',async()=>{
  const text='{"rows":[{"product":"maíz","volume":1,"field":"Peña","date":"2026-10-16"}]}';
  const bytes=Buffer.from(text),split=bytes.indexOf(Buffer.from('ñ'))+1;
  const decoded=await B.body(stream([bytes.subarray(0,split),bytes.subarray(split)]),1024*1024);
  assert.equal(decoded,text);
  const plan=I.prepare(JSON.parse(decoded).rows,{farm:'test-farm',sourceName:'synthetic.json',sourceKind:'dataset'});
  assert.equal(plan.records[0].field,'Peña');
});

test('request byte limit and invalid UTF-8 rejection apply to buffers and streams',async()=>{
  await assert.rejects(()=>B.body({body:Buffer.from([0xff])}),e=>e.status===400&&/UTF-8/.test(e.message));
  await assert.rejects(()=>B.body(stream([Buffer.from([0xc3]),Buffer.from([0x28])])),e=>e.status===400);
  await assert.rejects(()=>B.body(stream([Buffer.from('é')]),1),e=>e.status===413);
  await assert.rejects(()=>B.body({body:Buffer.from('é')},1),e=>e.status===413);
  assert.equal(await B.body({body:Buffer.from('Peña')}),'Peña');
  assert.deepEqual(await B.body({body:{field:'Peña'}}),{field:'Peña'});
});
