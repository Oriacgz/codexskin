import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createUiServer} from '../src/core/ui-server.js';
import {createThemeStore} from '../src/core/store.js';
import {buildSampleThemeZip,SAMPLE_THEMES} from '../src/core/sample-themes.js';
import {loadState,updateState} from '../src/core/state.js';
import {buildCollectionBackup} from '../src/core/backup.js';
import {compareVersions} from '../src/core/updates.js';
import {readFileLimited} from '../src/core/read-file.js';
import {loadTrustedKeys} from '../src/core/trust.js';
async function fixture(work,options={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-reaudit-')),previous=process.env.CODEXSKIN_HOME,oldLaunch=process.env.CODEXSKIN_NO_LAUNCH;
 process.env.CODEXSKIN_HOME=dir;process.env.CODEXSKIN_NO_LAUNCH='1';const ui=createUiServer(options);
 await new Promise(r=>ui.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${ui.server.address().port}/t/${ui.token}/`;
 const post=async(route,value)=>{const response=await fetch(base+route,{method:'POST',body:Buffer.isBuffer(value)?value:JSON.stringify(value)});return response.json();};
 try{await work({dir,post,store:createThemeStore(path.join(dir,'themes'))});}
 finally{await new Promise(r=>ui.server.close(r));if(previous===undefined)delete process.env.CODEXSKIN_HOME;else process.env.CODEXSKIN_HOME=previous;if(oldLaunch===undefined)delete process.env.CODEXSKIN_NO_LAUNCH;else process.env.CODEXSKIN_NO_LAUNCH=oldLaunch;await fs.rm(dir,{recursive:true,force:true});}
}
test('first import cannot overtake a queued manual theme switch',async()=>{
 let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),calls=[];
 await fixture(async({store,post})=>{
  const first=await store.installFromZip(buildSampleThemeZip(SAMPLE_THEMES[0]));
  const manual=post('apply/'+first.theme.id,{});await ready;
  const imported=post('import/next.zip',buildSampleThemeZip(SAMPLE_THEMES[1]));
  // Allow the import to validate while manual apply owns the queue.
  await new Promise(r=>setTimeout(r,100));
  release();const result=await imported;assert.equal((await manual).ok,true);
  assert.deepEqual(calls,[first.theme.id]);assert.equal(result.autoApplied,false);
  assert.equal((await loadState()).activeThemeId,first.theme.id);
 },{apply:async(store,id)=>{calls.push(id);if(calls.length===1){entered();await gate;}await updateState({activeThemeId:id});return {windows:1};}});
});
test('restoring a selected theme pauses an enabled schedule until its next boundary',async()=>{
 await fixture(async({store,post})=>{
  const first=await store.installFromZip(buildSampleThemeZip(SAMPLE_THEMES[0]));
  const backup=await buildCollectionBackup(store,{activeThemeId:first.theme.id});
  await updateState({schedule:{enabled:true,dayTime:'07:00',nightTime:'19:00',dayThemeId:first.theme.id,nightThemeId:first.theme.id}});
  const review=await post('backup/review',backup);assert.equal(review.ok,true);
  assert.equal((await post('backup/restore',{reviewId:review.reviewId,restoreSelection:true})).ok,true);
  assert.ok((await loadState()).schedulePausedUntil>Date.now());
 });
});
test('editing the previous active theme cannot undo a queued manual switch',async()=>{
 let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),calls=[];
 await fixture(async({store,post})=>{
  const first=await store.installFromZip(buildSampleThemeZip(SAMPLE_THEMES[0])),second=await store.installFromZip(buildSampleThemeZip(SAMPLE_THEMES[1]));
  let queried;const query=new Promise(r=>queried=r);
  const debuggerServer=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify([{id:'mock',type:'page',title:'Codex'}]));queried();});
  await new Promise(r=>debuggerServer.listen(0,'127.0.0.1',r));
  try{
   await updateState({activeThemeId:first.theme.id,debugPort:debuggerServer.address().port});
   const manual=post('apply/'+second.theme.id,{});await ready;
   const edit=post('theme/'+first.theme.id+'/settings',{accent:'#ff8800'});await query;
   release();assert.equal((await manual).ok,true);assert.equal((await edit).applied,false);
   assert.deepEqual(calls,[second.theme.id]);assert.equal((await loadState()).activeThemeId,second.theme.id);
  }finally{release();await new Promise(r=>debuggerServer.close(r));}
 },{apply:async(store,id)=>{calls.push(id);if(calls.length===1){entered();await gate;}await updateState({activeThemeId:id});return {windows:1};}});
});
test('release comparison rejects malformed semantic versions',()=>{
 for(const version of ['1.0.0-01','1.0.0-alpha..1','1.0.0-.','1.0.0+build..1','1.0.0+','9'.repeat(257)+'.0.0'])assert.throws(()=>compareVersions(version,'1.0.0'));
});
test('expired backup review is released even without another upload',async t=>{
 await fixture(async({store,post})=>{
  await store.installFromZip(buildSampleThemeZip(SAMPLE_THEMES[0]));
  const backup=await buildCollectionBackup(store,{});
  t.mock.timers.enable({apis:['setTimeout']});
  const review=await post('backup/review',backup);assert.equal(review.ok,true);
  t.mock.timers.tick(600001);
  const result=await post('backup/restore',{reviewId:review.reviewId,restoreSelection:false});
  assert.equal(result.ok,false);assert.match(result.error,/expired/);
  t.mock.timers.reset();
 });
});
test('bounded file reads accept exact limit and reject oversized archives and trusted keys',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-file-limit-'));try{
  const file=path.join(dir,'input');await fs.writeFile(file,'12345678');assert.equal(await readFileLimited(file,8,'utf8'),'12345678');
  await assert.rejects(readFileLimited(file,7),/exceeds/);
  await fs.truncate(file,262145);await assert.rejects(loadTrustedKeys(file),/exceeds/);
  await assert.rejects(readFileLimited(dir,8),/regular file|EISDIR|EPERM/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('bounded file reads reject growth after stat and always close the handle',async t=>{
 let readCount=0,closed=false;
 t.mock.method(fs,'open',async()=>({stat:async()=>({size:0,isFile:()=>true}),read:async buffer=>{readCount++;buffer.fill(65);return {bytesRead:Math.min(4,buffer.length)};},close:async()=>{closed=true;}}));
 await assert.rejects(readFileLimited('growing',8),/exceeds/);assert.equal(readCount,3);assert.equal(closed,true);
});
test('CLI refuses oversized archive before importing or installing it',async()=>{
 await fixture(async({dir})=>{
  const file=path.join(dir,'large.zip');await fs.writeFile(file,'');await fs.truncate(file,32*1024*1024+1);
  await assert.rejects(promisify(execFile)(process.execPath,['bin/codexskin.mjs','import',file],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env},windowsHide:true,timeout:10000}),error=>/File exceeds 33554432 bytes/.test(error.stderr));
  assert.equal((await createThemeStore(path.join(dir,'themes')).list()).length,0);
 });
});
