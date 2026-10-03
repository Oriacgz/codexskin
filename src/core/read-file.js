import fs from 'node:fs/promises';

// Bound allocation before reading user-selected archives/keys, including growth
// after the initial stat. Symlinks may resolve to regular files; devices do not.
export async function readFileLimited(file,maxBytes,encoding) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('Invalid file limit');
  const handle=await fs.open(file,'r');
  try{
    const stat=await handle.stat();
    if(!stat.isFile())throw new Error('Expected a regular file');
    if(stat.size>maxBytes)throw new Error(`File exceeds ${maxBytes} bytes`);
    const chunks=[];let total=0;
    while(true){
      const bytes=Buffer.alloc(Math.min(65536,maxBytes+1-total));
      const result=await handle.read(bytes,0,bytes.length,null);
      if(!result.bytesRead)break;
      total+=result.bytesRead;
      if(total>maxBytes)throw new Error(`File exceeds ${maxBytes} bytes`);
      chunks.push(bytes.subarray(0,result.bytesRead));
    }
    const result=Buffer.concat(chunks,total);return encoding?result.toString(encoding):result;
  }finally{await handle.close();}
}
