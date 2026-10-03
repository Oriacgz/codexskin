import fs from 'node:fs/promises';
import path from 'node:path';
import {withFileLock} from './atomic.js';

export const LOG_LIMITS=Object.freeze({fileBytes:1024*1024,recordBytes:8192});
export async function appendRotatingLog(file,message) {
  const encoded=Buffer.from(String(message).replace(/\r?\n$/,''));
  const record=encoded.length+1<=LOG_LIMITS.recordBytes?Buffer.concat([encoded,Buffer.from('\n')])
    :Buffer.from(new TextDecoder().decode(encoded.subarray(0,LOG_LIMITS.recordBytes-4),{stream:true})+'…\n');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await withFileLock(file+'.lock',async()=>{
    const previous=file+'.1';
    async function stat(name){try{const info=await fs.lstat(name);if(!info.isFile()||info.isSymbolicLink())throw new Error('Log must be a regular file');return info;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
    if((await stat(previous))?.size>LOG_LIMITS.fileBytes)await fs.rm(previous);
    const current=await stat(file);
    // Oversized legacy logs are discarded rather than retained above the cap.
    if(current?.size>LOG_LIMITS.fileBytes)await fs.rm(file);
    else if(current&&current.size+record.length>LOG_LIMITS.fileBytes)await fs.rename(file,previous);
    await fs.appendFile(file,record,{mode:0o600});
  });
}
