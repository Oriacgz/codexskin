import assert from 'node:assert/strict';
import {test} from 'node:test';
import {activateCodexWindow} from '../src/core/launch-window.js';
import fs from 'node:fs/promises';

test('explicit launch restores and activates main without closing detached windows',async()=>{
 const commands=[];
 const result=await activateCodexWindow(9223,{
  targets:async()=>[{id:'main',type:'page',url:'app://-/index.html'},{id:'detached',type:'page',title:'Codex',url:'app://-/detached-window.html'}],
  focus:async()=>commands.push(['main','Native.restore']),
  connect:async(_, {target})=>({evaluate:async()=>({populated:true}),send:async(method,params)=>{commands.push([target.id,method,params]);return {windowId:7};},close(){}}),pause:async()=>{},
 });
 assert.equal(result.activated,true);
 assert.deepEqual(commands.map(c=>c[1]),['Page.bringToFront','Native.restore']);
 assert.ok(commands.every(c=>c[0]==='main'));
});
test('GUI launch does not use the console helper hide flag',async()=>{
 const source=await fs.readFile(new URL('../src/core/launch.js',import.meta.url),'utf8');
 assert.match(source,/stdio: "ignore",[\s\S]*?windowsHide: false/);
});
