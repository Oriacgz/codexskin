// Isolated CLI smoke test against the supplied mock endpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SAMPLE_THEMES, buildSampleThemeZip } from '../src/core/sample-themes.js';
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname,'..');
const home = await fs.mkdtemp(path.join(os.tmpdir(),'codexskin-smoke-'));
const reservation = http.createServer();
await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
const port = reservation.address().port;
await new Promise(r=>reservation.close(r));
const env={...process.env,CODEXSKIN_HOME:home,CODEXSKIN_NO_LAUNCH:'1'};
await fs.writeFile(path.join(home,'state.json'),JSON.stringify({debugPort:port}));
const mock=spawn(process.execPath,['tools/mock-codex.mjs','--port',String(port)],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let mockLog='';mock.stdout.on('data',d=>mockLog+=d);mock.stderr.on('data',d=>mockLog+=d);
const checks=[];
try {
  let ready=false;
  for(let i=0;i<30;i++) {
    try {const r=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(100)}); if(r.ok){ready=true;break;}} catch {}
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(ready,mockLog);
  const zip=path.join(home,'sample.zip');
  await fs.writeFile(zip,buildSampleThemeZip(SAMPLE_THEMES[0]));
  async function cli(args,pattern) {
    const {stdout}=await run(process.execPath,['bin/codexskin.mjs',...args],{cwd:root,env,windowsHide:true,timeout:15000});
    assert.match(stdout,pattern); checks.push({command:args[0],status:'PASS'});console.log(`PASS CLI ${args[0]}`);
  }
  await cli(['--help'],/Usage:/);
  await cli(['import',zip],/aurora-veil/i);
  await cli(['list'],/Aurora Veil/);
  await cli(['apply','aurora-veil'],/verified/);
  await cli(['verify'],/"ok": true/);
  await cli(['restore'],/Restored official appearance/);
  assert.equal(JSON.parse(await fs.readFile(path.join(home,'state.json'),'utf8')).activeThemeId,null);
  await cli(['remove','aurora-veil'],/Removed theme/);
  await cli(['list'],/No themes installed/);
  await fs.writeFile(path.join(root,'audit','integration-results.json'),JSON.stringify({checks,limitation:'The supplied mock emulates payload results; it does not render CSS or run the generated UI JavaScript.'},null,2));
} finally {
  mock.kill();
  await new Promise(r=>mock.exitCode!==null?r():mock.once('exit',r));
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));
  await fs.rm(home,{recursive:true,force:true});
}
