import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import {buildSampleThemeZip,SAMPLE_THEMES} from '../src/core/sample-themes.js';
const root=path.resolve(import.meta.dirname,'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cs-executable-'));
const home=path.join(temp,'fresh-home');
const child=spawn(path.resolve(root,process.argv[2] ?? 'dist/codexskin-app.exe'),['--no-open','--no-tray','--no-watch'],{
  cwd:root,env:{...process.env,CODEXSKIN_HOME:home,CODEXSKIN_NO_LAUNCH:'1'},windowsHide:true,stdio:['ignore','pipe','pipe'],
});
let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
try {
  let runtime;
  for(let i=0;i<100&&!runtime&&child.exitCode===null;i++) {
    try {runtime=JSON.parse(await fs.readFile(path.join(home,'ui-runtime.json'),'utf8'));}
    catch {await new Promise(r=>setTimeout(r,50));}
  }
  assert.ok(runtime,stderr || stdout || 'executable did not initialize');
  const base=`http://127.0.0.1:${runtime.port}/t/${runtime.token}/`;
  const html=await (await fetch(base+'app')).text();
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.match(html,/A fresh look/);
  assert.equal(await (await fetch(base+'ping')).text(),'ok');
  const post=async(route,body)=>{const response=await fetch(base+route,{method:'POST',body:Buffer.isBuffer(body)?body:JSON.stringify(body)});return response.json();};
  assert.equal((await post('import/sample.zip',buildSampleThemeZip(SAMPLE_THEMES[0]))).ok,true);
  let state=await (await fetch(base+'state')).json();const id=state.themes[0].id;
  assert.equal((await post('favorite/'+id,{favorite:true})).ok,true);
  assert.equal((await post('settings/schedule',{enabled:true,dayTime:'07:00',nightTime:'19:00',dayThemeId:id,nightThemeId:id})).ok,true);
  state=await (await fetch(base+'state')).json();assert.equal(state.themes[0].favorite,true);assert.equal(state.schedule.enabled,true);
  assert.match(html,/id="checkUpdates"/);assert.match(html,/id="releaseNotes"/);
  const updates=await post('updates/check',{});assert.equal(updates.ok,true);assert.match(updates.currentVersion,/^\d+\.\d+\.\d+$/);
  const persisted=JSON.parse(await fs.readFile(path.join(home,'state.json'),'utf8'));assert.ok(persisted.favoriteThemeIds.includes(id));assert.equal(persisted.schedule.enabled,true);
  await fetch(base+'quit',{method:'POST'});
  for(let i=0;i<100&&child.exitCode===null;i++)await new Promise(r=>setTimeout(r,50));
  assert.equal(child.exitCode,0,stderr);
  assert.equal(stderr,'');
  const result={startup:'PASS',generatedClient:'PASS',tokenedPing:'PASS',gracefulQuit:'PASS'};
  await fs.writeFile(path.join(import.meta.dirname,'executable-results.json'),JSON.stringify(result,null,2));
  console.log('PASS executable: fresh startup, generated UI, favorites, scheduling, update controls, ping, graceful quit');
} finally {
  if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));
  await fs.rm(temp,{recursive:true,force:true});
}
