import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {withFileLock} from '../src/core/atomic.js';

test('lock metadata write failure closes and removes acquired lock', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-lock-'));
  const file=path.join(dir,'writer.lock');
  const open=fs.open;
  let closed=false;
  fs.open=async (...args)=>{
    const handle=await open(...args);
    return {writeFile:async()=>{throw new Error('simulated disk failure');},close:async()=>{closed=true;await handle.close();}};
  };
  try {
    await assert.rejects(()=>withFileLock(file,()=>assert.fail('action must not run')), /simulated disk failure/);
    assert.equal(closed,true);
    await assert.rejects(()=>fs.access(file), {code:'ENOENT'});
  } finally {fs.open=open;await fs.rm(dir,{recursive:true,force:true});}
});
