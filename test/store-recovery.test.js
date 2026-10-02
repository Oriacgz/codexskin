import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createThemeStore } from '../src/core/store.js';
import { SAMPLE_THEMES, buildSampleThemeZip } from '../src/core/sample-themes.js';

async function fixture(work) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-recovery-'));
  const store=createThemeStore(dir),theme=SAMPLE_THEMES[0];
  try {await store.installFromZip(buildSampleThemeZip(theme));await work({dir,store,id:theme.id});}
  finally {assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});}
}

test('interrupted directory replacement rolls back before reads',()=>fixture(async({dir,store,id})=>{
  const previous=JSON.parse(await fs.readFile(path.join(dir,id+'.json'),'utf8'));
  const stage='.stage-'+id+'-interrupted',backup='.old-'+id+'-interrupted';
  await fs.rename(path.join(dir,id),path.join(dir,backup));
  await fs.mkdir(path.join(dir,id));
  await fs.writeFile(path.join(dir,id,'theme.json'),'{}');
  await fs.writeFile(path.join(dir,'.transaction-'+id+'.json'),JSON.stringify({id,stage,backup,hadOld:true,previous,next:{...previous,transactionId:'new-transaction'}}));
  assert.equal((await store.loadPayload(id)).theme.id,id);
  assert.equal((await store.list()).length,1);
  assert.ok(!(await fs.readdir(dir)).some(name=>name.startsWith('.transaction-')||name.startsWith('.old-')));
}));

test('cached payload still detects changed bytes and cannot be mutated by callers',()=>fixture(async({dir,store,id})=>{
  const payload=await store.loadPayload(id);
  payload.theme.name='Changed by caller';
  assert.notEqual((await store.loadPayload(id)).theme.name,'Changed by caller');
  await fs.writeFile(path.join(dir,id,'background.png'),'corrupt');
  await assert.rejects(()=>store.loadPayload(id),/checksum/);
}));

test('store refuses a linked payload directory',()=>fixture(async({dir,store,id})=>{
  const original=path.join(dir,id), renamed=path.join(dir,'linked-source');
  await fs.rename(original,renamed);
  await fs.symlink(renamed,original,process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>store.loadPayload(id),/directory must not be a link/);
}));
