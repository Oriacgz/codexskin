import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inspectImage} from '../src/core/image.js';
import {encodePng} from '../src/core/png.js';
import {createCustomTheme,validateSettings} from '../src/core/customization.js';
import {importThemePackage} from '../src/core/package.js';
import {buildZip} from '../src/core/zip-write.js';
import {inspectDebugListener,assertDebugPortSafe,isLoopbackAddress,parseListeners} from '../src/core/debug-security.js';
import {connectCdp,listTargets} from '../src/core/cdp.js';
import {appendRotatingLog,LOG_LIMITS} from '../src/core/log.js';
import {buildTrayHostPs1} from '../src/core/tray.js';
import {renderApp} from '../src/core/ui-page.js';

const png=()=>encodePng(2,3,Buffer.alloc(24));
function webp(kind,payload){const header=Buffer.alloc(20);header.write('RIFF');header.writeUInt32LE(12+payload.length,4);header.write('WEBP',8);header.write(kind,12);header.writeUInt32LE(payload.length,16);return Buffer.concat([header,payload]);}

test('dimensions parse PNG, JPEG and every static WebP header variant',()=>{
 assert.deepEqual(inspectImage(png()),{width:2,height:3,media:'image/png'});
 assert.deepEqual(inspectImage(Buffer.from([255,216,255,224,0,4,0,0,255,192,0,11,8,0,3,0,2,1,1,17,0,255,217])),{width:2,height:3,media:'image/jpeg'});
 const extended=Buffer.alloc(10);extended[4]=1;extended[7]=2;
 assert.deepEqual(inspectImage(webp('VP8X',extended)),{width:2,height:3,media:'image/webp'});
 const lossy=Buffer.from([0,0,0,157,1,42,2,0,3,0]);assert.equal(inspectImage(webp('VP8 ',lossy)).height,3);
 const lossless=Buffer.from([47,1,128,0,0]);assert.deepEqual(inspectImage(webp('VP8L',lossless)),{width:2,height:3,media:'image/webp'});
 extended[0]=2;assert.throws(()=>inspectImage(webp('VP8X',extended)),/Animated WebP/);
});

test('oversized, zero, missing and truncated image dimensions fail before creation or import',()=>{
 const oversized=png();oversized.writeUInt32BE(20000,16);
 assert.throws(()=>inspectImage(oversized),/resize/);
 const pixels=png();pixels.writeUInt32BE(8000,16);pixels.writeUInt32BE(6000,20);assert.throws(()=>inspectImage(pixels),/40 million/);
 const zero=png();zero.writeUInt32BE(0,20);assert.throws(()=>inspectImage(zero),/dimensions/);
 for(const bad of [png().subarray(0,24),Buffer.from([255,216,255,192,0,11,8]),Buffer.from('RIFF')])assert.throws(()=>inspectImage(bad),/dimensions/);
 assert.throws(()=>createCustomTheme({name:'Huge',image:oversized.toString('base64'),settings:validateSettings({})}),/resize/);
 const archive=buildZip(new Map([['theme.json',Buffer.from(JSON.stringify({schemaVersion:1,id:'huge',image:'background.png'}))],['background.png',oversized]]));
 assert.throws(()=>importThemePackage(archive),/resize/);
 // Browser uses the same self-contained function before Image.decode().
 const browser=vm.runInNewContext('('+inspectImage.toString()+')');assert.throws(()=>browser(oversized),/resize/);
 const html=renderApp({token:'test'});assert.ok(html.indexOf('inspectImage(new Uint8Array(await file.arrayBuffer()))')<html.indexOf('await image.decode()'));
});

test('listener inspection allows IPv4/IPv6 loopback and rejects unsafe or unverified bindings',async()=>{
 for(const address of ['127.0.0.1','127.4.5.6','::1','::ffff:127.0.0.1'])assert.equal(isLoopbackAddress(address),true);
 for(const address of ['0.0.0.0','::','192.168.0.2','127.evil','localhost','*'])assert.equal(isLoopbackAddress(address),false);
 const inspect=addresses=>({platform:'win32',run:async()=>({stdout:JSON.stringify(addresses.map(address=>({address,port:1234})))})});
 assert.equal((await inspectDebugListener(1234,inspect(['127.0.0.1','::1']))).status,'loopback');
 await assert.rejects(()=>assertDebugPortSafe(1234,inspect(['127.0.0.1','0.0.0.0'])),{code:'CDP_UNSAFE_BINDING'});
 await assert.rejects(()=>assertDebugPortSafe(1234,{platform:'win32',run:async()=>{throw new Error('No permissions');}}),{code:'CDP_BINDING_UNVERIFIED'});
 await assert.rejects(()=>assertDebugPortSafe(1234,inspect([])),{code:'CDP_NOT_LISTENING'});
 await assertDebugPortSafe(1234,{...inspect([]),requireListener:false});
 await assert.rejects(()=>inspectDebugListener(70000),/Invalid debugger port/);
 assert.deepEqual(parseListeners('p1\nn127.0.0.1:1234\nn[::1]:1234\n','darwin'),[{address:'127.0.0.1',port:1234},{address:'::1',port:1234}]);
 assert.deepEqual(parseListeners('LISTEN 0 128 0.0.0.0:1234 0.0.0.0:*\n','linux'),[{address:'0.0.0.0',port:1234}]);
});

test('real wildcard listeners cannot receive a CDP discovery or WebSocket request',async()=>{
 let requests=0;const server=http.createServer((req,res)=>{requests++;res.end('[]');});
 await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
 try{
  const port=server.address().port;
  assert.equal((await inspectDebugListener(port,{fresh:true})).status,'unsafe');
  await assert.rejects(()=>listTargets(port),{code:'CDP_UNSAFE_BINDING'});
  await assert.rejects(()=>connectCdp(port,{target:{webSocketDebuggerUrl:'ws://127.0.0.1:'+port+'/devtools'}}),{code:'CDP_UNSAFE_BINDING'});
  assert.equal(requests,0);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('rotating logs bound retention and Unicode records across concurrent writers',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-log-limit-')),file=path.join(dir,'watch.log');
 try{
  await fs.writeFile(file,'old\n'+'x'.repeat(LOG_LIMITS.fileBytes-4));
  await appendRotatingLog(file,'new record');assert.equal((await fs.stat(file+'.1')).size,LOG_LIMITS.fileBytes);
  await Promise.all(Array.from({length:16},(_,i)=>appendRotatingLog(file,'record-'+i)));
  const current=await fs.readFile(file,'utf8');for(let i=0;i<16;i++)assert.ok(current.includes('record-'+i+'\n'));
  await appendRotatingLog(file,'😀'.repeat(10000));const records=(await fs.readFile(file)).toString('utf8').trimEnd().split('\n');
  assert.ok(Buffer.byteLength(records.at(-1)+'\n')<=LOG_LIMITS.recordBytes);assert.ok(!records.at(-1).includes('\ufffd'));
  await fs.truncate(file,LOG_LIMITS.fileBytes+1);await fs.truncate(file+'.1',LOG_LIMITS.fileBytes+1);
  await appendRotatingLog(file,'after legacy cleanup');assert.ok((await fs.stat(file)).size<LOG_LIMITS.fileBytes);await assert.rejects(()=>fs.access(file+'.1'),{code:'ENOENT'});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
 const tray=buildTrayHostPs1();assert.match(tray,/Length -gt 1048576/);assert.match(tray,/Move-Item -LiteralPath \$LogFile/);
});

test('Windows signing script parses and refuses invalid configuration before signing',{skip:process.platform!=='win32'},async()=>{
 const run=promisify(execFile),script=path.resolve('tools/sign-exe.ps1');
 await assert.rejects(()=>run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Executable','does-not-exist.exe','-Thumbprint','bad','-TimestampUrl','https://example.invalid'],{windowsHide:true}),error=>error.stderr.includes('Expected certificate'));
 await assert.rejects(()=>run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Executable','does-not-exist.exe','-Thumbprint','0'.repeat(40),'-TimestampUrl','http://example.invalid'],{windowsHide:true}),error=>error.stderr.includes('HTTPS'));
 await assert.rejects(()=>run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Executable','does-not-exist.exe','-Thumbprint','0'.repeat(40),'-TimestampUrl','https://example.invalid'],{windowsHide:true}),error=>error.stderr.includes('No usable code-signing certificate'));
 const source=await fs.readFile('tools/build-exe.mjs','utf8');assert.ok(source.indexOf('if(signingRequested)run')>source.indexOf('set-exe-icon.ps1'));
});

test('native PowerShell tray logging rotates and caps records',{skip:process.platform!=='win32'},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-tray-log-')),file=path.join(dir,'tray.log'),run=promisify(execFile);
 try{
  await fs.writeFile(file,'x'.repeat(LOG_LIMITS.fileBytes));
  const tray=buildTrayHostPs1(),functionText=tray.slice(tray.indexOf('function Log([string]$msg)'),tray.indexOf('function Invoke-Api'));
  const script="$ErrorActionPreference='Stop'; $LogFile='"+file.replace(/'/g,"''")+"';\n"+functionText+"\nLog ('😀' * 10000); Log 'last record'";
  await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true});
  assert.ok((await fs.stat(file)).size<=LOG_LIMITS.fileBytes);assert.equal((await fs.stat(file+'.1')).size,LOG_LIMITS.fileBytes);
  const text=await fs.readFile(file,'utf8');assert.ok(text.includes('last record'));assert.ok(!text.includes('\ufffd'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('launcher includes an explicit loopback address and validates the debugger port',async()=>{
 const source=await fs.readFile('src/core/launch.js','utf8');assert.match(source,/--remote-debugging-address=127\.0\.0\.1/);assert.match(source,/if \(!validDebugPort\(port\)\)/);
 const validation=source.indexOf('await assertDebugPortSafe(port'),launch=source.indexOf('const child = spawn(');assert.ok(validation>0&&validation<launch);
});
