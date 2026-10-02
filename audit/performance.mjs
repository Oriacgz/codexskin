// A synthetic large-image benchmark. No real app or user store is involved.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createThemeStore } from '../src/core/store.js';
import { buildZip } from '../src/core/zip-write.js';
import { buildApplyExpression } from '../src/core/payload.js';
const home=await fs.mkdtemp(path.join(os.tmpdir(),'codexskin-perf-'));
const theme={schemaVersion:1,id:'perf-theme',name:'Performance',image:'background.png'};
const image=Buffer.alloc(8*1024*1024,1);
Buffer.from([137,80,78,71,13,10,26,10]).copy(image);
const store=createThemeStore(home);
const realRead=fs.readFile;
try {
  await store.installFromZip(buildZip(new Map([['theme.json',Buffer.from(JSON.stringify(theme))],['background.png',image]])));
  let reads=0,imageReads=0,payload;
  fs.readFile=async function(file,...args){reads++;if(String(file).endsWith('background.png'))imageReads++;return realRead.call(this,file,...args);};
  const times=[],expressionTimes=[];
  for(let i=0;i<10;i++) {
    let start=performance.now();payload=await store.loadPayload(theme.id);times.push(performance.now()-start);
    start=performance.now();buildApplyExpression({...payload.theme,dataUrl:payload.dataUrl},payload.css);expressionTimes.push(performance.now()-start);
  }
  const average=values=>Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(2));
  const result={node:process.version,imageBytes:image.length,iterations:10,readCallsPerLoad:reads/10,imageReadsPerLoad:imageReads/10,
    imageBytesReadPerLoad: imageReads/10*image.length,averageLoadMs:average(times),averageExpressionBuildMs:average(expressionTimes),
    expressionCharacters:buildApplyExpression({...payload.theme,dataUrl:payload.dataUrl},payload.css).length,
    limitation:'Synthetic magic-byte-valid image; filesystem cache is warm. These are local measurements, not production latency guarantees.'};
  console.log(JSON.stringify(result,null,2));
  await fs.writeFile(path.join(import.meta.dirname,'performance-results.json'),JSON.stringify(result,null,2));
} finally {
  fs.readFile=realRead;
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));
  await fs.rm(home,{recursive:true,force:true});
}
