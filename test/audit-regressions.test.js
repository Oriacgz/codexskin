import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { updateState, loadState } from '../src/core/state.js';
import { closeCodex } from '../src/core/launch.js';

test('all twenty audited regression checks pass', {timeout:65000}, async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['audit/checks.mjs'],{
    cwd:path.resolve(import.meta.dirname,'..'),windowsHide:true,timeout:60000,
  });
  assert.match(stdout,/20\/20 audit checks passed/);
});

test('state updates preserve independent fields across concurrent processes',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cs-state-regression-'));
  const before=process.env.CODEXSKIN_HOME;
  process.env.CODEXSKIN_HOME=home;
  const run=promisify(execFile);
  try {
    const moduleUrl=new URL('../src/core/state.js',import.meta.url).href;
    await Promise.all(Array.from({length:4},(_,index)=>run(process.execPath,['--input-type=module','-e',
      `import {updateState} from ${JSON.stringify(moduleUrl)}; await updateState({field${index}:true});`
    ],{env:{...process.env,CODEXSKIN_HOME:home},windowsHide:true})));
    const state=await loadState();
    for(let i=0;i<4;i++)assert.equal(state[`field${i}`],true);
    await updateState({activeThemeId:null});
    assert.equal((await loadState()).field0,true);
  } finally {
    if(before===undefined)delete process.env.CODEXSKIN_HOME;else process.env.CODEXSKIN_HOME=before;
    assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(home,{recursive:true,force:true});
  }
});

test('test kill-switch also prohibits closing the real Codex process', async () => {
  const previous=process.env.CODEXSKIN_NO_LAUNCH;
  process.env.CODEXSKIN_NO_LAUNCH='1';
  try {await assert.rejects(closeCodex(),/disabled in this environment/);}
  finally {if(previous===undefined)delete process.env.CODEXSKIN_NO_LAUNCH;else process.env.CODEXSKIN_NO_LAUNCH=previous;}
});
