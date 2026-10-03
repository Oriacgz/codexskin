import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {deflateRawSync} from 'node:zlib';
import {buildZip} from '../src/core/zip-write.js';
import {readZip} from '../src/core/zip.js';
import {validateCollectionBackup} from '../src/core/backup.js';
import {createThemeStore} from '../src/core/store.js';
import {buildSampleThemeZip,SAMPLE_THEMES} from '../src/core/sample-themes.js';
import {buildStartupShortcutCmd,writeTrayAssets} from '../src/core/tray.js';
import {logoIcoBase64} from '../src/core/brand-assets.js';
import {renderApp} from '../src/core/ui-page.js';

// Build a small compressed fixture from the writer's existing CRC/header data.
function compressedZip(entries) {
  const parts=[],central=[];let offset=0;
  for(const [name,data] of entries){
    const stored=buildZip(new Map([[name,data]])),nameBytes=Buffer.from(name),compressed=deflateRawSync(data);
    const local=Buffer.from(stored.subarray(0,30)),cd=Buffer.from(stored.subarray(30+nameBytes.length+data.length,76+nameBytes.length+data.length));
    local.writeUInt16LE(8,8);local.writeUInt32LE(compressed.length,18);
    cd.writeUInt16LE(8,10);cd.writeUInt32LE(compressed.length,20);cd.writeUInt32LE(offset,42);
    parts.push(local,nameBytes,compressed);central.push(cd,nameBytes);offset+=30+nameBytes.length+compressed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.from(buildZip(new Map()).subarray(-22));
  end.writeUInt16LE(entries.size,8);end.writeUInt16LE(entries.size,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,directory,end]);
}

test('nested backup expansion is bounded across all packages',()=>{
  const image=Buffer.alloc(9*1024*1024);Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64').copy(image);
  const files=new Map(),ids=[];
  for(let i=0;i<8;i++){
    const id='large-'+i;ids.push(id);
    files.set('themes/'+id+'.codextheme',compressedZip(new Map([
      ['theme.json',Buffer.from(JSON.stringify({schemaVersion:1,id,name:id,image:'background.png'}))],['background.png',image]
    ])));
  }
  files.set('backup.json',Buffer.from(JSON.stringify({format:'codexskin-backup',version:1,themeIds:ids,preferences:{selectedThemeId:null}})));
  const bytes=buildZip(files);assert.ok(bytes.length<1024*1024);
  assert.throws(()=>validateCollectionBackup(bytes),/expanded archive too large/);
  assert.throws(()=>readZip(compressedZip(new Map([['large',image]])),{maxTotalBytes:1024}),/expanded archive too large/);
});

test('invalid recovery journals cannot partially delete valid themes',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cs-security-'));
  try{
    const store=createThemeStore(home);await store.installFromZip(buildSampleThemeZip(SAMPLE_THEMES[0]));
    await fs.writeFile(path.join(home,'.merge-transaction.json'),JSON.stringify({ids:[SAMPLE_THEMES[0].id,'../outside'],stage:'.stage-merge-test'}));
    await assert.rejects(()=>store.list(),/Invalid backup merge journal/);
    await fs.access(path.join(home,SAMPLE_THEMES[0].id,'theme.json'));
    await fs.rm(path.join(home,'.merge-transaction.json'));
    const entry=JSON.parse(await fs.readFile(path.join(home,SAMPLE_THEMES[0].id+'.json'),'utf8'));
    const image=entry.files.find(file=>file.name.startsWith('background.'));
    await fs.truncate(path.join(home,SAMPLE_THEMES[0].id,image.name),11*1024*1024);
    await assert.rejects(()=>store.loadPayload(SAMPLE_THEMES[0].id),/size limits/);
  }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('startup shortcut names cannot escape the Startup folder',()=>{
  for(const name of ['../other','..\\other','a/b','a\\b',''])assert.throws(()=>buildStartupShortcutCmd('app.exe',{name}),/Invalid startup shortcut name/);
  assert.match(buildStartupShortcutCmd('app.exe',{name:'codexskin-test'}).lnkPath,/codexskin-test\.lnk$/);
});

test('tray assets use the official logo instead of the obsolete generated glyph',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cs-logo-')),previous=process.env.CODEXSKIN_HOME;
  try{process.env.CODEXSKIN_HOME=home;const assets=await writeTrayAssets();assert.deepEqual(await fs.readFile(assets.iconPath),Buffer.from(logoIcoBase64,'base64'));}
  finally{if(previous===undefined)delete process.env.CODEXSKIN_HOME;else process.env.CODEXSKIN_HOME=previous;await fs.rm(home,{recursive:true,force:true});}
});

test('theme downloads reject JSON errors instead of saving invalid archives',async()=>{
  const html=renderApp({token:'test'}),start=html.indexOf('  async function downloadRoute('),end=html.indexOf('  function downloadBlob(',start);
  let downloaded=false;
  const context=vm.createContext({base:'/',AbortSignal,downloadBlob(){downloaded=true;},fetch:async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:false,error:'Damaged theme'})})});
  vm.runInContext(html.slice(start,end),context);
  await assert.rejects(()=>context.downloadRoute('theme/broken/export','theme.zip'),/Damaged theme/);assert.equal(downloaded,false);
  assert.match(html,/await downloadRoute\('theme\/'.*\/export'/);
});
