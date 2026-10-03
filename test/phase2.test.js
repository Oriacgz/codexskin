import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {suggestPalette} from '../src/core/palette.js';
import {buildCollectionBackup,validateCollectionBackup} from '../src/core/backup.js';
import {buildZip} from '../src/core/zip-write.js';
import {readZip} from '../src/core/zip.js';
import {createThemeStore} from '../src/core/store.js';
import {createCustomTheme,validateSettings} from '../src/core/customization.js';
import {buildSampleThemeZip,SAMPLE_THEMES} from '../src/core/sample-themes.js';
import {importThemePackage} from '../src/core/package.js';
import {createUiServer} from '../src/core/ui-server.js';
import {updateState,loadState} from '../src/core/state.js';
import {buildDiagnosticReport,diagnosticLogErrors,classifyError} from '../src/core/diagnostics.js';
process.env.CODEXSKIN_NO_LAUNCH='1';
const image=importThemePackage(buildSampleThemeZip(SAMPLE_THEMES[0])).image.bytes.toString('base64');
const custom=name=>createCustomTheme({name,image,settings:validateSettings({accent:'#338855'})});

test('local palette suggestions reflect the image and validate samples',()=>{
 const result=suggestPalette([...Array(100).fill([20,200,100]),...Array(50).fill([10,10,10])]);
 assert.equal(result.colors[0],'#20c060');assert.ok(result.colors.includes(result.accent));assert.match(result.primary,/^#[a-f0-9]{6}$/);
 assert.equal(suggestPalette([[250,250,250]]).primary,'#18201f');
 assert.throws(()=>suggestPalette([]));assert.throws(()=>suggestPalette([[NaN,0,0]]));
});
test('backup validates every nested package, restores a fresh collection and keeps conflicts unchanged',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'cs-backup-'));
 try{
  const source=createThemeStore(path.join(home,'source')),one=custom('One'),two=custom('Two');await source.installFromZip(one.zip);await source.installFromZip(two.zip);
  const bytes=await buildCollectionBackup(source,{activeThemeId:one.theme.id,themeOverrides:{[one.theme.id]:validateSettings({imageMode:'fit',accent:'#ff8800'})},token:'SECRET'});
  const backup=validateCollectionBackup(bytes);assert.equal(backup.packages.length,2);assert.equal(backup.selectedThemeId,one.theme.id);
  assert.ok(![...readZip(bytes).values()].some(value=>value.includes(Buffer.from('SECRET'))));
  const target=createThemeStore(path.join(home,'target'));await target.installFromZip(one.zip);const before=JSON.stringify(await target.loadPayload(one.theme.id));
  const result=await target.mergePackages(backup.packages.map(p=>p.zip));assert.deepEqual(result.added,[two.theme.id]);assert.deepEqual(result.skipped,[one.theme.id]);assert.equal(JSON.stringify(await target.loadPayload(one.theme.id)),before);
  const fresh=createThemeStore(path.join(home,'fresh'));await fresh.mergePackages(backup.packages.map(p=>p.zip));assert.equal((await fresh.loadPayload(one.theme.id)).theme.settings.imageMode,'fit');
  const files=readZip(bytes);files.set('themes/'+two.theme.id+'.codextheme',Buffer.from('bad package'));assert.throws(()=>validateCollectionBackup(buildZip(files)));
  assert.equal((await target.list()).length,2);
  await assert.rejects(()=>target.mergePackages([custom('Three').zip,Buffer.from('bad package')]));assert.equal((await target.list()).length,2);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
test('failed batch merge rolls back every addition and preserves existing themes',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'cs-merge-')),dir=path.join(home,'themes'),store=createThemeStore(dir),originalRename=fs.rename;
 try{
  const existing=custom('Existing'),one=custom('New one'),two=custom('New two');await store.installFromZip(existing.zip);
  let writes=0;fs.rename=async(from,to)=>{if(path.dirname(to)===dir&&to.endsWith('.json')&&++writes===2)throw new Error('Injected write failure');return originalRename(from,to);};
  await assert.rejects(()=>store.mergePackages([one.zip,two.zip]),/Injected write failure/);fs.rename=originalRename;
  assert.deepEqual((await store.list()).map(t=>t.id),[existing.theme.id]);assert.ok(await store.loadPayload(existing.theme.id));assert.ok(!(await fs.readdir(dir)).includes('.merge-transaction.json'));
 }finally{fs.rename=originalRename;await fs.rm(home,{recursive:true,force:true});}
});
test('diagnostics never include raw paths, tokens, theme names or log messages',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'cs-diagnostics-'));
 try{
  await fs.writeFile(path.join(home,'watch.log'),'failed to fetch http://127.0.0.1:1234/t/PRIVATE-TOKEN C:\\Users\\private-account\\file mail@example.com\n');
  const logErrors=await diagnosticLogErrors(home),report=buildDiagnosticReport({found:{path:'C:\\private'},running:true,reachable:false,themes:[{name:'SECRET THEME'}],selected:'SECRET-ID',compatibility:{windows:[{url:'https://private',warnings:['PRIVATE-TOKEN']}],warnings:[]},recentErrors:[{code:classifyError('fetch PRIVATE-TOKEN')}],logErrors});
  const text=JSON.stringify(report);for(const secret of ['PRIVATE-TOKEN','private-account','mail@example.com','SECRET THEME','SECRET-ID','https://private'])assert.ok(!text.includes(secret));assert.ok(text.includes('CONNECTION_FAILED'));
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
test('backup review requires a matching review, saves recovery before merge, and rejects malformed uploads',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'cs-backup-api-')),old=process.env.CODEXSKIN_HOME;process.env.CODEXSKIN_HOME=home;
 const {server,token}=createUiServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/t/${token}/`;
 const request=(route,body)=>fetch(base+route,{method:'POST',body:Buffer.isBuffer(body)?body:JSON.stringify(body??{})});
 try{
  const store=createThemeStore(path.join(home,'themes')),existing=custom('Existing');await store.installFromZip(existing.zip);await updateState({activeThemeId:existing.theme.id,autoRestart:true,privateToken:'SECRET'});
  const source=createThemeStore(path.join(home,'incoming')),added=custom('Added');await source.installFromZip(added.zip);const bytes=await buildCollectionBackup(source,{activeThemeId:added.theme.id});
  const invalid=await (await request('backup/review',Buffer.from('bad'))).json();assert.equal(invalid.ok,false);assert.equal((await store.list()).length,1);
  const review=await (await request('backup/review',bytes)).json();assert.equal(review.ok,true);assert.equal(review.themes[0].conflict,false);
  assert.equal((await (await request('backup/restore',{reviewId:'wrong',restoreSelection:false})).json()).ok,false);
  const restored=await (await request('backup/restore',{reviewId:review.reviewId,restoreSelection:false})).json();assert.equal(restored.added,1);assert.equal((await loadState()).activeThemeId,existing.theme.id);assert.equal((await loadState()).autoRestart,true);
  const recovery=validateCollectionBackup(await fs.readFile(path.join(home,'backups','pre-restore-latest.zip')));assert.deepEqual(recovery.packages.map(p=>p.theme.id),[existing.theme.id]);
  assert.equal((await (await request('backup/restore',{reviewId:review.reviewId,restoreSelection:false})).json()).ok,false);
  const downloaded=await request('backup/export');assert.equal(validateCollectionBackup(Buffer.from(await downloaded.arrayBuffer())).packages.length,2);
  const report=await (await fetch(base+'diagnostics')).json();assert.equal(report.ok,true);assert.ok(!JSON.stringify(report).includes('SECRET'));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.CODEXSKIN_HOME;else process.env.CODEXSKIN_HOME=old;await fs.rm(home,{recursive:true,force:true});}
});
