import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createUiServer} from '../src/core/ui-server.js';
import {createThemeStore} from '../src/core/store.js';
import {buildSampleThemeZip,SAMPLE_THEMES} from '../src/core/sample-themes.js';
import {importThemePackage} from '../src/core/package.js';
import {defaultSettings,validateSettings,customizePayload} from '../src/core/customization.js';
import {assessContrast} from '../src/core/readability.js';
import {buildApplyExpression} from '../src/core/payload.js';
process.env.CODEXSKIN_NO_LAUNCH='1';
test('image placement preserves legacy focal points and rejects unsafe settings',()=>{
 const theme=importThemePackage(buildSampleThemeZip(SAMPLE_THEMES[0])).theme;
 theme.art.focusX=.2;theme.art.focusY=.7;
 const legacy={brightness:100};
 const custom=customizePayload({theme},{themeOverrides:{[theme.id]:legacy}}).theme;
 assert.equal(custom.customization.imageX,20);assert.equal(custom.customization.imageY,70);
 assert.equal(defaultSettings(theme).imageMode,'fill');
 for(const input of [{imageMode:'stretch'},{imageZoom:99},{imageZoom:251},{imageX:-1},{imageY:101}])assert.throws(()=>validateSettings(input));
 custom.customization=validateSettings({imageMode:'fit',imageZoom:150,imageX:20,imageY:70});
 const css=JSON.parse(buildApplyExpression({...custom,dataUrl:'data:image/png;base64,'},'').match(/const STYLE_CSS = (.+);/)[1]);
 assert.match(css,/background-size: contain !important/);assert.match(css,/transform: scale\(1.5\)/);assert.match(css,/background-position: 20% 70% !important/);
});
test('contrast estimates use image brightness and surface opacity',()=>{
 const s=validateSettings({textColorsEnabled:true,primaryTextColor:'#ffffff',secondaryTextColor:'#ffffff',pageOpacity:0});
 assert.equal(assessContrast(s,[[255,255,255]]).find(v=>v.surface==='Pages').low,true);
 assert.equal(assessContrast({...s,pageOpacity:100},[[255,255,255]]).find(v=>v.surface==='Pages').low,false);
 assert.equal(assessContrast({...s,brightness:20},[[255,255,255]]).find(v=>v.surface==='Pages').low,false);
});
test('saved theme export and duplicate preserve image, CSS, settings and independent IDs',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'cs-portable-')),old=process.env.CODEXSKIN_HOME;process.env.CODEXSKIN_HOME=home;
 const {server,token}=createUiServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/t/${token}/`;
 const post=(route,body={})=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  const page=await fetch(base+'app'),html=await page.text(),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(!script.includes('\r'),'served script must use browser-normalized line endings');
  assert.ok(page.headers.get('content-security-policy').includes(createHash('sha256').update(script).digest('base64')));
  const store=createThemeStore(path.join(home,'themes')),source=importThemePackage(buildSampleThemeZip(SAMPLE_THEMES[0]));await store.installFromZip(buildSampleThemeZip(SAMPLE_THEMES[0]));
  const id=source.theme.id,settings=validateSettings({...defaultSettings(source.theme,source.css),imageMode:'fit',imageZoom:130,imageX:27,pageOpacity:44,accent:'#aa5500'});
  const untouched=importThemePackage(Buffer.from(await (await post('theme/'+id+'/export')).arrayBuffer()));
  assert.equal(untouched.theme.settings,undefined,'untouched packages retain legacy rendering');assert.deepEqual(untouched.theme.art,source.theme.art);
  await post('theme/'+id+'/settings',settings);
  const response=await post('theme/'+id+'/export');assert.equal(response.status,200);
  const exported=Buffer.from(await response.arrayBuffer()),imported=importThemePackage(exported);
  assert.deepEqual(imported.theme.settings,settings);assert.deepEqual(imported.image.bytes,source.image.bytes);assert.equal(imported.css,source.css);
  const fresh=createThemeStore(path.join(home,'fresh'));await fresh.installFromZip(exported);const restored=await fresh.loadPayload(id);
  assert.deepEqual(customizePayload(restored,{}).theme.customization,settings);
  const duplicated=await (await post('theme/'+id+'/duplicate',{name:'My independent copy'})).json();assert.equal(duplicated.ok,true);assert.notEqual(duplicated.theme.id,id);
  assert.deepEqual(defaultSettings((await store.loadPayload(duplicated.theme.id)).theme),settings);
  await post('theme/'+duplicated.theme.id+'/settings',{...settings,accent:'#123456'});
  assert.deepEqual((await (await fetch(base+'theme/'+id+'/settings')).json()).settings,settings);
  await post('remove/'+duplicated.theme.id);assert.ok(await store.loadPayload(id));
  assert.equal((await (await post('theme/'+id+'/duplicate',{name:''})).json()).ok,false);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.CODEXSKIN_HOME;else process.env.CODEXSKIN_HOME=old;await fs.rm(home,{recursive:true,force:true});}
});
