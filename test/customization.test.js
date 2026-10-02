import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateSettings,defaultSettings,customizePayload,createCustomTheme} from '../src/core/customization.js';
import {createUiServer} from '../src/core/ui-server.js';
import {createThemeStore} from '../src/core/store.js';
import {buildSampleThemeZip,SAMPLE_THEMES} from '../src/core/sample-themes.js';
import {importThemePackage} from '../src/core/package.js';
import {createWatchDeps} from '../src/core/watch.js';
import {buildApplyExpression,buildVerifyExpression} from '../src/core/payload.js';
import {loadState} from '../src/core/state.js';
process.env.CODEXSKIN_NO_LAUNCH='1';
const pkg=importThemePackage(buildSampleThemeZip(SAMPLE_THEMES[0]));
const settings={...defaultSettings(pkg.theme),brightness:65,sidebarOpacity:100,chatOpacity:30,accent:'#ff8844'};
test('editor defaults preserve imported sidebar and composer colors and alpha',()=>{
 const values=defaultSettings(pkg.theme,pkg.css);
 assert.equal(values.sidebarColor,'#101820');assert.equal(values.sidebarOpacity,40);
 assert.equal(values.chatColor,'#101820');assert.equal(values.chatOpacity,55);
});
test('customization rejects unsafe colors, ranges, unknown and prototype fields',()=>{
 for(const input of [{brightness:NaN},{brightness:181},{sidebarOpacity:-1},{accent:'red;}'},{css:'body{}'},JSON.parse('{"__proto__":{}}'),null,[]])assert.throws(()=>validateSettings(input));
 assert.deepEqual(validateSettings(settings),settings);
});
test('customization leaves package payload untouched and revisions track changes/reset',()=>{
 const payload={theme:pkg.theme,css:pkg.css,dataUrl:'data:image/png;base64,test'};
 const saved=JSON.stringify(payload);
 const custom=customizePayload(payload,{themeOverrides:{[pkg.theme.id]:settings}});
 assert.equal(JSON.stringify(payload),saved);
 assert.equal(custom.theme.colors.accent,settings.accent);
 assert.notEqual(custom.theme.customizationRevision,customizePayload(payload,{}).theme.customizationRevision);
 const expression=buildApplyExpression({...custom.theme,dataUrl:payload.dataUrl},custom.css);
 assert.match(expression,/brightness\(0.65\)/);
 assert.match(expression,/rgba\(16,24,32,1\)/);
 assert.match(expression,/z-index: -1/);
 assert.match(expression,/html\[data-codexskin=\\"active\\"\] #codexskin-layer \{ opacity: 1 !important;/);
 assert.match(buildVerifyExpression(pkg.theme.id,custom.theme.customizationRevision),/revisionMatches/);
});
test('creator validates image and name; generates distinct installable packages',()=>{
 const input={name:'My workspace',image:pkg.image.bytes.toString('base64'),settings};
 const one=createCustomTheme(input),two=createCustomTheme(input);
 assert.notEqual(one.theme.id,two.theme.id);
 assert.equal(importThemePackage(one.zip).theme.name,input.name);
 for(const bad of [{...input,name:33},{...input,image:'dGV4dA=='},{...input,image:'%%%'}])assert.throws(()=>createCustomTheme(bad));
});
test('UI saves imported settings, watcher loads them, reset preserves original, creator and removal work offline',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'cs-editor-'));
 const old=process.env.CODEXSKIN_HOME;process.env.CODEXSKIN_HOME=home;
 const {server,token}=createUiServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/t/${token}/`;
 const request=async(route,body)=> (await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
 try {
  const store=createThemeStore(path.join(home,'themes'));await store.installFromZip(buildSampleThemeZip(SAMPLE_THEMES[0]));
  const id=pkg.theme.id,original=JSON.stringify(await store.loadPayload(id));
  assert.equal((await request('theme/'+id+'/settings')).name,pkg.theme.name);
  assert.equal((await request('theme/'+id+'/settings',settings)).ok,true);
  assert.deepEqual((await createWatchDeps({store,themeId:id}).loadPayload()).theme.customization,settings);
  assert.equal(JSON.stringify(await store.loadPayload(id)),original);
  assert.equal((await request('theme/'+id+'/settings',{brightness:999})).ok,false);
  assert.deepEqual((await loadState()).themeOverrides[id],settings);
  await request('theme/'+id+'/settings',{reset:true});assert.equal((await loadState()).themeOverrides[id],undefined);
  const created=await request('create',{name:'Custom image',image:pkg.image.bytes.toString('base64'),settings});
  assert.equal(created.ok,true);assert.deepEqual((await request('theme/'+created.theme.id+'/settings')).settings,settings);
  await request('remove/'+created.theme.id,{});assert.equal((await loadState()).themeOverrides[created.theme.id],undefined);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.CODEXSKIN_HOME;else process.env.CODEXSKIN_HOME=old;await fs.rm(home,{recursive:true,force:true});}
});

test('message darkness validates independently and old settings remain compatible',()=>{
 const {userMessageDarkness,assistantMessageDarkness,...legacy}=settings;
 assert.equal(validateSettings(legacy).userMessageDarkness,0);
 assert.equal(validateSettings(legacy).assistantMessageDarkness,0);
 for(const key of ['userMessageDarkness','assistantMessageDarkness']){
  for(const value of [-1,101,NaN,'70'])assert.throws(()=>validateSettings({...settings,[key]:value}));
 }
 const custom=customizePayload({theme:pkg.theme,css:pkg.css,dataUrl:'data:image/png;base64,'+pkg.image.bytes.toString('base64')},{themeOverrides:{[pkg.theme.id]:{...settings,userMessageDarkness:65,assistantMessageDarkness:80}}});
 const expression=buildApplyExpression({...custom.theme,dataUrl:custom.dataUrl},custom.css);
 const source=expression.match(/const STYLE_CSS = (.+);/)[1];
 const css=JSON.parse(source);
 assert.ok(css.includes('background: rgba(16,19,22,0.65) !important'));
 assert.ok(css.includes('background: rgba(16,19,22,0.8) !important'));
 assert.ok(css.includes('[data-markdown-text-style="assistant-message"]:not(:empty)'));
 assert.ok(css.includes(':not(:has(.bg-user-message))'));
 const legacyPayload=customizePayload({theme:pkg.theme},{themeOverrides:{[pkg.theme.id]:legacy}});
 assert.equal(legacyPayload.theme.customization.userMessageDarkness,0);
});

test('sidebar darkness preserves old surfaces and darkens light themes independently',async()=>{
 const {sidebarSurface}=await import('../src/core/customization.js');
 const {sidebarDarkness,...legacy}=settings;
 assert.equal(validateSettings(legacy).sidebarDarkness,0);
 assert.equal(sidebarSurface({...settings,sidebarDarkness:0}),'rgba(16,24,32,1)');
 const light={...settings,sidebarColor:'#ffffff',sidebarOpacity:0,sidebarDarkness:80};
 assert.equal(sidebarSurface(light),'rgba(16,19,22,0.8)');
 assert.equal(sidebarSurface({...light,sidebarOpacity:100,sidebarDarkness:100}),'rgba(16,19,22,1)');
 for(const value of [-1,101,'80'])assert.throws(()=>validateSettings({...light,sidebarDarkness:value}));
 const payload=customizePayload({theme:pkg.theme,dataUrl:'data:image/png;base64,test'},{themeOverrides:{[pkg.theme.id]:light}});
 const expression=buildApplyExpression({...payload.theme,dataUrl:payload.dataUrl},null);
 const css=JSON.parse(expression.match(/const STYLE_CSS = (.+);/)[1]);
 assert.ok(css.includes('background: rgba(16,19,22,0.8) !important'));
 assert.ok(css.includes('--color-text-primary: #f4f6f8'));
 assert.equal(payload.theme.customization.chatOpacity,settings.chatOpacity);
});

test('thinking and working status darkness remains independent and backward compatible',()=>{
 const {activityDarkness,...legacy}=settings;
 assert.equal(validateSettings(legacy).activityDarkness,0);
 for(const value of [-1,101,'80'])assert.throws(()=>validateSettings({...legacy,activityDarkness:value}));
 const custom=customizePayload({theme:pkg.theme},{themeOverrides:{[pkg.theme.id]:{...legacy,activityDarkness:75}}});
 const css=JSON.parse(buildApplyExpression({...custom.theme,dataUrl:'data:image/png;base64,test'},null).match(/const STYLE_CSS = (.+);/)[1]);
 assert.ok(css.includes('.text-secondary:has(> button[aria-expanded]) { background: rgba(16,19,22,0.75)'));
 assert.ok(css.includes('[class~="group/agent-activity"] .text-size-chat.text-secondary.overflow-hidden'));
 assert.ok(css.includes('-webkit-text-fill-color: #f4f6f8'));
 assert.equal(custom.theme.customization.assistantMessageDarkness,settings.assistantMessageDarkness);
});

test('theme covers full-page shells and uses a single rounded composer surface',()=>{
 const payload=customizePayload({theme:pkg.theme},{themeOverrides:{[pkg.theme.id]:settings}});
 const css=JSON.parse(buildApplyExpression({...payload.theme,dataUrl:'data:image/png;base64,test'},null).match(/const STYLE_CSS = (.+);/)[1]);
 assert.ok(css.includes('[data-app-shell-main-surface="default"] { background: transparent !important; }'));
 assert.ok(css.includes('[class*="_FullHeightPageSurfaceLayout_"] { background: transparent !important; }'));
 assert.ok(css.includes('[data-app-shell-page-header] { background: rgba(16,19,22,0.32) !important; }'));
 assert.ok(css.includes('[data-app-shell-main-titlebar], html[data-codexskin="active"] [data-app-shell-page-header] [data-app-shell-page-header] { background: transparent !important; }'));
 assert.ok(css.includes('[class*="_ComposerLayoutBody_"] { background: rgba(16,24,32,0.3) !important;'));
 assert.ok(css.includes(':has([class*="_ComposerLayoutBody_"]) { background: transparent !important; backdrop-filter: none !important; }'));
 assert.ok(!css.includes('.bg-surface-card { background: transparent'));
});

test('text colors are opt-in, validated and override automatic darkness colors',()=>{
 const legacy=validateSettings({brightness:100});
 assert.equal(legacy.textColorsEnabled,false);
 for(const value of ['red','#fff','url(x)'])assert.throws(()=>validateSettings({primaryTextColor:value}));
 assert.throws(()=>validateSettings({textColorsEnabled:'true'}));
 const customized=customizePayload({theme:pkg.theme},{themeOverrides:{[pkg.theme.id]:{...settings,textColorsEnabled:true,primaryTextColor:'#eeddcc',secondaryTextColor:'#8899aa',sidebarDarkness:80,activityDarkness:70}}});
 const css=JSON.parse(buildApplyExpression({...customized.theme,dataUrl:'data:image/png;base64,test'},null).match(/const STYLE_CSS = (.+);/)[1]);
 assert.ok(css.includes('--tooltip-text-color: #eeddcc !important'));
 assert.ok(css.includes('[class*="_Tooltip_"]'));
 assert.ok(css.includes('--color-text: #eeddcc !important'));
 assert.ok(css.includes('--color-text-primary: #eeddcc'));
 assert.ok(css.includes('[data-automation-card] > button { background-color: rgba(16,19,22,.32)'));
 assert.ok(css.includes('--color-text-secondary: #8899aa'));
 assert.ok(css.lastIndexOf('color: #8899aa !important')>css.lastIndexOf('color: #f4f6f8 !important'));
 assert.ok(css.includes('--color-text-tertiary: #8899aa'));
 assert.ok(css.includes('.text-tertiary'));
 assert.ok(css.includes('[class*="text-text/"]'));
 assert.ok(css.includes('_cadencedShimmerSweep_'));
 assert.ok(css.includes(':where(pre,code) { color: #eeddcc'));
 assert.ok(css.includes('::placeholder { color: #8899aa'));
 assert.ok(css.includes('[data-placeholder])::before'));
 assert.ok(!css.includes('pre *'));
});

test('page and dialog opacity preserve old settings and validate bounds', () => {
 const old = validateSettings({brightness:100});
 assert.equal(old.pageOpacity,32);
 assert.equal(old.dialogOpacity,65);
 for(const key of ['pageOpacity','dialogOpacity']) {
  for(const value of [-1,101,NaN,'50']) assert.throws(()=>validateSettings({[key]:value}));
  assert.equal(validateSettings({[key]:0})[key],0);
  assert.equal(validateSettings({[key]:100})[key],100);
 }
 const theme={...pkg.theme,customization:validateSettings({pageOpacity:20,dialogOpacity:75}),dataUrl:'data:image/png;base64,test'};
 const css=JSON.parse(buildApplyExpression(theme,null).match(/const STYLE_CSS = (.+);/)[1]);
 assert.ok(css.includes('main[class~="h-full"][class~="bg-surface"] { background: rgba(16,19,22,0.2)'));
 assert.ok(css.includes(':is([role="dialog"],dialog) { background: rgba(16,19,22,0.75)'));
});
