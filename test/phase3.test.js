import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateSchedule,scheduleSlot,manualSchedulePause,createScheduler} from '../src/core/schedule.js';
import {compareVersions,verifiedReleaseUrl,checkUpdates,currentVersion} from '../src/core/updates.js';
import {createUiServer} from '../src/core/ui-server.js';
import {loadState} from '../src/core/state.js';
import {buildSampleThemeZip,SAMPLE_THEMES} from '../src/core/sample-themes.js';
import {buildTrayHostPs1} from '../src/core/tray.js';
const schedule={enabled:true,dayTime:'07:00',nightTime:'19:00',dayThemeId:'day',nightThemeId:'night'};
const date=(day,h,m=0)=>new Date(2026,9,day,h,m);
test('schedule handles midnight, exact boundaries and reversed day/night times',()=>{
 assert.equal(scheduleSlot(schedule,date(3,0)).themeId,'night');
 assert.equal(scheduleSlot(schedule,date(3,7)).themeId,'day');
 assert.equal(scheduleSlot(schedule,date(3,19)).themeId,'night');
 assert.equal(scheduleSlot({...schedule,dayTime:'19:00',nightTime:'07:00'},date(3,20)).themeId,'day');
 assert.equal(manualSchedulePause({schedule},date(3,20)),date(4,7).getTime());
 assert.throws(()=>validateSchedule({...schedule,nightTime:'07:00'}));
 assert.throws(()=>validateSchedule({...schedule,dayTime:'25:00'}));
 assert.throws(()=>validateSchedule({...schedule,dayThemeId:'../escape'}));
});
test('scheduler retries offline, catches resume boundaries, pauses manual overrides and serializes ticks',async()=>{
 let now=date(3,8),state={schedule},calls=[],offline=true,release;
 const tick=createScheduler({load:async()=>state,now:()=>now,apply:async id=>{calls.push(id);if(offline)throw new Error('offline');state.activeThemeId=id;}});
 await tick();offline=false;await tick();await tick();assert.deepEqual(calls,['day','day']);
 state.activeThemeId='manual';state.schedulePausedUntil=manualSchedulePause(state,now);await tick();assert.equal(calls.length,2);
 now=date(4,1);await tick();assert.equal(calls.at(-1),'night');
 now=date(4,8);await tick();assert.equal(calls.at(-1),'day');
 const slow=createScheduler({load:async()=>({schedule}),now:()=>now,apply:()=>new Promise(r=>{release=r;})});
 const first=slow();await new Promise(r=>setImmediate(r));await slow();release();await first;
});
test('release comparison respects numeric versions and prerelease precedence',()=>{
 for(const [a,b] of [['v0.10.0','0.9.9'],['1.0.0','1.0.0-rc.2'],['1.0.0-beta.10','1.0.0-beta.2'],['1.0.0-beta','1.0.0-2']])assert.equal(compareVersions(a,b),1);
 assert.equal(compareVersions('1.0.0+build','v1.0.0'),0);
 assert.throws(()=>compareVersions('latest','1.0.0'));
});
test('update checker verifies release origin, bounds notes and quietly handles offline errors',async()=>{
 const url='https://github.com/Oriacgz/codexskin/releases/tag/v99.0.0';
 const mock=async()=>new Response(JSON.stringify({tag_name:'v99.0.0',html_url:url,body:'<script>plain notes</script>'}));
 const result=await checkUpdates(mock);assert.equal(result.newer,true);assert.equal(result.url,url);assert.equal(result.currentVersion,currentVersion);
 for(const bad of ['https://evil.test/release','https://github.com.evil.test/Oriacgz/codexskin/releases/tag/v99.0.0',url+'?redirect=evil'])assert.throws(()=>verifiedReleaseUrl(bad,'v99.0.0'));
 assert.equal((await checkUpdates(async()=>{throw new Error('offline');})).unavailable,true);
 assert.equal((await checkUpdates(async()=>new Response('x'.repeat(262145)))).unavailable,true);
 assert.equal((await checkUpdates(async()=>new Response(JSON.stringify({tag_name:'v99.0.0',html_url:url,prerelease:true})))).unavailable,true);
});
test('favorites and schedules persist across servers, older themes work, invalid settings do not mutate state',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'cs-phase3-')),old=process.env.CODEXSKIN_HOME;
 process.env.CODEXSKIN_HOME=home;process.env.CODEXSKIN_NO_LAUNCH='1';let server;
 try{
  let ui=createUiServer();server=ui.server;await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let base=`http://127.0.0.1:${server.address().port}/t/${ui.token}/`;
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',body:Buffer.isBuffer(body)?body:JSON.stringify(body)});return r.json();};
  const imported=await post('import/old.zip',buildSampleThemeZip(SAMPLE_THEMES[0]));assert.equal(imported.ok,true);
  let state=await (await fetch(base+'state')).json();const id=state.themes[0].id;
  assert.equal(state.themes[0].favorite,false);assert.deepEqual(state.schedule,{enabled:false});
  assert.equal((await post('favorite/'+id,{favorite:true})).ok,true);
  const saved={...schedule,dayThemeId:id,nightThemeId:id};assert.equal((await post('settings/schedule',saved)).ok,true);
  assert.equal((await post('settings/schedule',{...saved,dayTime:'bad'})).ok,false);
  assert.deepEqual((await loadState()).schedule,saved);
  await new Promise(r=>server.close(r));ui=createUiServer();server=ui.server;await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}/t/${ui.token}/`;
  state=await (await fetch(base+'state')).json();assert.equal(state.themes[0].favorite,true);assert.deepEqual(state.schedule,saved);
  assert.equal((await post('favorite/'+id,{favorite:false})).ok,true);assert.deepEqual((await loadState()).favoriteThemeIds,[]);
  assert.match(buildTrayHostPs1(),/\$item.Checked = \[bool\]\$theme.active/);
 }finally{if(server?.listening)await new Promise(r=>server.close(r));if(old===undefined)delete process.env.CODEXSKIN_HOME;else process.env.CODEXSKIN_HOME=old;await fs.rm(home,{recursive:true,force:true});}
});
