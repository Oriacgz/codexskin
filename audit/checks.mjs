// Focused regression checks for the defects found in the original audit.
// Run explicitly: node audit/checks.mjs. Also included in the standard tests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { renderApp } from '../src/core/ui-page.js';
import { normalizeTheme } from '../src/core/theme.js';
import { buildApplyExpression, buildVerifyExpression } from '../src/core/payload.js';
import { validateSafeCss } from '../src/core/safe-css.js';
import { createThemeStore } from '../src/core/store.js';
import { buildZip } from '../src/core/zip-write.js';
import { readZip } from '../src/core/zip.js';
import { saveState, loadState } from '../src/core/state.js';
import { resolvePort, parseWindowsProcessPid } from '../src/core/launch.js';
import { createUiServer } from '../src/core/ui-server.js';
import { createWatchDeps, watchTick, runWatchLoop, WATCH_ACTIONS } from '../src/core/watch.js';
import { connectCdp } from '../src/core/cdp.js';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const results = [];
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexskin-audit-'));
const oldHome = process.env.CODEXSKIN_HOME;
const oldNoLaunch = process.env.CODEXSKIN_NO_LAUNCH;
process.env.CODEXSKIN_HOME = home;
process.env.CODEXSKIN_NO_LAUNCH = '1';
const theme = { schemaVersion: 1, id: 'audit-theme', name: 'Audit', image: 'background.png', tagline: 'Preserve this' };
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64');
function zip(input = theme) {
  return buildZip(new Map([['theme.json', Buffer.from(JSON.stringify(input))], ['background.png', image]]));
}
async function check(id, title, fn) {
  try { await fn(); results.push({ id, title, status: 'PASS' }); }
  catch (error) { results.push({ id, title, status: 'FAIL', error: error.message }); }
  console.log(`${results.at(-1).status} ${id}: ${title}`);
}
function dom() {
  const elements = new Map(), attributes = new Map();
  const documentElement = {
    appendChild(el) { elements.set(el.id, el); },
    setAttribute(k,v) { attributes.set(k,v); },
    getAttribute(k) { return attributes.get(k) ?? null; },
    removeAttribute(k) { attributes.delete(k); },
  };
  return {
    window: { location: { hash: '#home' } },
    document: { documentElement, getElementById(id) { return elements.get(id); }, createElement() {
      return { style: { setProperty(name,value) { this[name] = value; if(name==='background-image')this.backgroundImage=value; } }, setAttribute() {}, getBoundingClientRect() { return { height: 900 }; },
        remove() { elements.delete(this.id); } };
    } }, elements,
  };
}
function watchDeps(overrides = {}) {
  return { loadPayload: async () => ({ theme: normalizeTheme(theme), dataUrl: 'data:image/png;base64,AA==' }),
    isReachable: async () => true, port: async () => 1, listTargets: async () => [{id:'one',type:'page'}],
    connect: async () => ({ evaluate: async () => ({ok:true}), close() {} }), log() {}, ...overrides };
}
const watchState = () => ({lastMessage:null,transientCount:0,toleranceTicks:3});
async function mockCdp(mode, fn) {
  const sockets = new Set();
  const server = http.createServer((req,res) => {
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify([{id:'one',type:'page',webSocketDebuggerUrl:`ws://127.0.0.1:${server.address().port}/one`} ]));
  });
  server.on('upgrade',(req,socket) => {
    sockets.add(socket);
    const key = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    if(mode === 'disconnect') socket.once('data',() => socket.destroy());
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let cdp;
  try { cdp = await connectCdp(server.address().port,{timeoutMs:100}); await fn(cdp); }
  finally { cdp?.close(); for(const s of sockets) s.destroy(); server.close(); server.closeAllConnections(); }
}
try {
  await check('B01','Generated UI JavaScript parses',()=>{
    const script = renderApp({token:'audit'}).match(/<script>([\s\S]*?)<\/script>/)[1];
    new vm.Script(script);
  });
  await check('B02','Windows close parser extracts PID from tasklist CSV',async()=>{
    // Deterministic tasklist /FO CSV fixture. Live tasklist was denied by
    // this environment, so process inspection is not needed for this proof.
    const line = '"ChatGPT.exe","1234","Console","1","120,000 K"';
    const extracted = parseWindowsProcessPid(line);
    assert.equal(extracted,'1234',`PID parser returned ${extracted}; tasklist PID is 1234`);
  });
  await check('B03','UI starts when data directory does not yet exist',async()=>{
    const fresh = path.join(home,'fresh-home');
    const child=spawn(process.execPath,['bin/codexskin-ui.mjs','--no-open','--no-watch','--no-tray'],{cwd:root,env:{...process.env,CODEXSKIN_HOME:fresh},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    try {
      for(let i=0;i<60&&!stdout.includes('/app')&&child.exitCode===null;i++)await new Promise(r=>setTimeout(r,50));
      assert.doesNotMatch(stderr,/ENOENT/);assert.match(stdout,/http:\/\/127\.0\.0\.1:\d+\/t\//);
      let runtime;
      for(let i=0;i<40&&!runtime;i++) {
        try {runtime=JSON.parse(await fs.readFile(path.join(fresh,'ui-runtime.json'),'utf8'));}
        catch {await new Promise(r=>setTimeout(r,25));}
      }
      assert.ok(runtime,'startup did not publish runtime state');
      await fetch(`http://127.0.0.1:${runtime.port}/t/${runtime.token}/quit`,{method:'POST'});
    } finally {child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));}
  });
  await check('B04','Root theme CSS targets document root',()=>{
    const context = dom();
    vm.runInNewContext(buildApplyExpression({...normalizeTheme(theme),dataUrl:'data:image/png;base64,AA=='},validateSafeCss('root { --ds-theme-surface-opacity: 0.72; }')),context);
    assert.doesNotMatch(context.elements.get('codexskin-style').textContent,/html\[data-codexskin="active"\] html\s*\{/);
  });
  await check('B05','Background focus uses CSS percentages',()=>{
    const context=dom();
    vm.runInNewContext(buildApplyExpression({...normalizeTheme(theme),dataUrl:'data:image/png;base64,AA=='},null),context);
    const css=context.elements.get('codexskin-style').textContent;
    assert.match(css,/--cs-focus-x:\s*50%|background-position:\s*calc\(var\(--cs-focus-x\)\s*\*\s*100%\)/);
  });
  await check('B06','Theme copy survives install and load',async()=>{
    const store=createThemeStore(path.join(home,'copy-store'));
    await store.installFromZip(zip());
    assert.equal((await store.loadPayload(theme.id)).theme.copy.tagline,theme.tagline);
  });
  await check('B07','Re-import repairs damaged installed theme',async()=>{
    const dir=path.join(home,'repair-store'),store=createThemeStore(dir);
    await store.installFromZip(zip());
    await fs.writeFile(path.join(dir,theme.id,'background.png'),'corrupted');
    await store.installFromZip(zip());
    await store.loadPayload(theme.id);
  });
  await check('B08','Undeclared CSS added after install is rejected',async()=>{
    const dir=path.join(home,'extra-store'),store=createThemeStore(dir);
    await store.installFromZip(zip());
    await fs.writeFile(path.join(dir,theme.id,'theme.css'),'composer { background-image: url(https://example.invalid/audit); }');
    await assert.rejects(()=>store.loadPayload(theme.id));
  });
  await check('B09','Watch tolerance counts failed ticks, not failed windows',async()=>{
    const state=watchState();
    const outcome=await watchTick(watchDeps({listTargets:async()=>Array.from({length:4},(_,i)=>({id:String(i),type:'page'})),connect:async()=>{throw new Error('temporary disconnect');}}),state);
    assert.equal(outcome.action,WATCH_ACTIONS.TRANSIENT);
    assert.equal(state.transientCount,1);
  });
  await check('B10','Repeated watch tick crashes eventually exhaust tolerance',async()=>{
    let attempts=0;
    const result=await runWatchLoop(watchDeps({intervalMs:0,loadPayload:async()=>{attempts++;throw new Error('damaged theme');}}),{shouldStop:()=>attempts>=5});
    assert.equal(result.action,WATCH_ACTIONS.GAVE_UP);
  });
  await check('B11','Persisted false restart preference means never ask',async()=>{
    await saveState({autoRestart:false,debugPort:65534});
    assert.equal(await createWatchDeps({store:{},restartRunning:true}).resolveRestartPolicy(),'never');
  });
  await check('B12','Offline UI restore clears active theme',async()=>{
    const reservation=http.createServer();
    await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
    const port=reservation.address().port;
    await new Promise(r=>reservation.close(r));
    await saveState({activeThemeId:theme.id,autoRestart:false,debugPort:port});
    const {server,token}=createUiServer();
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    try {
      const response=await fetch(`http://127.0.0.1:${server.address().port}/t/${token}/restore`,{method:'POST'});
      assert.equal((await response.json()).ok,true);
      assert.equal((await loadState()).activeThemeId,null);
    } finally {server.close();server.closeAllConnections();}
  });
  await check('B13','CDP disconnect rejects pending evaluation',()=>mockCdp('disconnect',async cdp=>{
    const result=await Promise.race([cdp.evaluate('1').then(()=> 'resolved',()=> 'rejected'),new Promise(r=>setTimeout(()=>r('pending'),500))]);
    assert.equal(result,'rejected');
  }));
  await check('B14','CDP timeout bounds unanswered evaluation',()=>mockCdp('silent',async cdp=>{
    const result=await Promise.race([cdp.evaluate('1').then(()=> 'resolved',()=> 'rejected'),new Promise(r=>setTimeout(()=>r('pending'),500))]);
    assert.equal(result,'rejected');
  }));
  await check('B15','ZIP rejects inconsistent declared expanded length',()=>{
    const archive=zip();
    const central=archive.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    archive.writeUInt32LE(123456,central+24);
    assert.throws(()=>readZip(archive));
  });
  await check('B16','Saved debug port must be within TCP range',async()=>{
    await saveState({debugPort:-1});
    assert.ok((await resolvePort())>0);
  });
  await check('B17','Safe CSS rejects URL tokens in custom properties',()=>{
    assert.throws(()=>validateSafeCss('root { --ds-theme-font-family: url(https://example.invalid/audit); }'));
  });
  await check('B18','Watch updates skin mode after route changes',async()=>{
    const context=dom();
    vm.runInNewContext(buildApplyExpression({...normalizeTheme(theme),dataUrl:'data:image/png;base64,AA=='},null),context);
    context.window.location.hash='#thread';
    await watchTick(watchDeps({connect:async()=>({evaluate:async expression=>vm.runInNewContext(expression,context),close(){}})}),watchState());
    assert.equal(context.document.documentElement.getAttribute('data-codexskin-mode'),'task');
  });
  await check('B19','Concurrent imports of same theme both complete safely',async()=>{
    const store=createThemeStore(path.join(home,'concurrent-store'));
    const outcomes=await Promise.allSettled([store.installFromZip(zip()),store.installFromZip(zip())]);
    assert.deepEqual(outcomes.map(o=>o.status),['fulfilled','fulfilled']);
    await store.loadPayload(theme.id);
  });
  await check('C01','Verify rejects missing background image',()=>{
    const context=dom();
    vm.runInNewContext(buildApplyExpression({...normalizeTheme(theme),dataUrl:'data:image/png;base64,AA=='},null),context);
    context.elements.get('codexskin-layer').style.backgroundImage='none';
    // A positive-height layer without its background must fail verification.
    assert.equal(vm.runInNewContext(buildVerifyExpression(theme.id),context).ok,false);
  });
  await fs.writeFile(path.join(root,'audit','results.json'),JSON.stringify({node:process.version,platform:process.platform,checks:results},null,2));
} finally {
  if(oldHome===undefined) delete process.env.CODEXSKIN_HOME; else process.env.CODEXSKIN_HOME=oldHome;
  if(oldNoLaunch===undefined) delete process.env.CODEXSKIN_NO_LAUNCH; else process.env.CODEXSKIN_NO_LAUNCH=oldNoLaunch;
  // home is an absolute directory returned by mkdtemp within the OS temp directory.
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(home,{recursive:true,force:true});
}
console.log(`${results.filter(r=>r.status==='PASS').length}/${results.length} audit checks passed`);
process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
