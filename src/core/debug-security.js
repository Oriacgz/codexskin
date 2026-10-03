import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isIP} from 'node:net';

const runCommand=promisify(execFile);
const cache=new Map(),pending=new Map();
export function validDebugPort(port) { return Number.isInteger(port)&&port>=1&&port<=65535; }
export function isLoopbackAddress(address) {
  const value=address.toLowerCase().replace(/^\[|\]$/g,'');
  if(value==='::1')return true;
  const ipv4=value.startsWith('::ffff:')?value.slice(7):value;
  return isIP(ipv4)===4&&ipv4.startsWith('127.');
}
export function parseListeners(stdout,platform) {
  if(platform==='win32'){
    const entries=JSON.parse(stdout);
    if(!Array.isArray(entries)||entries.some(e=>typeof e.address!=='string'||!validDebugPort(e.port)))throw new Error('Invalid listener inventory');
    return entries;
  }
  const endpoints=platform==='darwin'?stdout.split(/\r?\n/).filter(line=>line.startsWith('n')).map(line=>line.slice(1))
    :stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>line.trim().split(/\s+/)[3]);
  return endpoints.map(endpoint=>{
    const match=/^(.*):(\d+)$/.exec(endpoint??'');
    if(!match||!validDebugPort(Number(match[2])))throw new Error('Invalid listener inventory');
    return {address:match[1].replace(/^\[|\]$/g,''),port:Number(match[2])};
  });
}
async function readInventory(run,platform) {
  const options={timeout:5000,windowsHide:true,maxBuffer:1024*1024};
  if(platform==='win32'){
    const script="$ErrorActionPreference='Stop'; $items=@([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { [pscustomobject]@{address=$_.Address.ToString();port=$_.Port} }); ConvertTo-Json -InputObject $items -Compress";
    return parseListeners((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],options)).stdout,platform);
  }
  if(platform==='darwin'){
    try{return parseListeners((await run('/usr/sbin/lsof',['-nP','-iTCP','-sTCP:LISTEN','-F','n'],options)).stdout,platform);}
    catch(error){if(error.code===1&&!error.stdout?.trim()&&!error.stderr?.trim())return [];throw error;}
  }
  if(platform==='linux')return parseListeners((await run('ss',['-H','-ltn'],options)).stdout,platform);
  throw new Error('Unsupported listener inspection platform');
}
export async function inspectDebugListener(port,{run=runCommand,platform=process.platform,fresh=false}={}) {
  if(!validDebugPort(port))throw new Error('Invalid debugger port');
  try{
    let entries;
    if(run!==runCommand||platform!==process.platform||fresh)entries=await readInventory(run,platform);
    else{
      if(Date.now()>=(cache.get(port)?.expires??0)&&!pending.has(port))pending.set(port,readInventory(run,platform).then(result=>{
        if(cache.size>=32)cache.delete(cache.keys().next().value);
        cache.set(port,{entries:result,expires:Date.now()+1000});return result;
      }).finally(()=>pending.delete(port)));
      entries=pending.has(port)?await pending.get(port):cache.get(port).entries;
    }
    const listeners=entries.filter(e=>e.port===port);
    return {status:!listeners.length?'not-listening':listeners.every(e=>isLoopbackAddress(e.address))?'loopback':'unsafe',listenerCount:listeners.length};
  }catch{return {status:'unknown',listenerCount:0};}
}
export async function assertDebugPortSafe(port,{requireListener=true,...options}={}) {
  const result=await inspectDebugListener(port,options);
  if(result.status==='loopback'||(!requireListener&&result.status==='not-listening'))return result;
  const error=new Error(result.status==='unsafe'?'Debugger listens beyond loopback. Close Codex manually and relaunch with codexskin.'
    :result.status==='unknown'?'Cannot verify debugger binding. Check OS listener inspection before connecting.'
    :'Debugger is not listening on the selected port.');
  error.code=result.status==='unsafe'?'CDP_UNSAFE_BINDING':result.status==='unknown'?'CDP_BINDING_UNVERIFIED':'CDP_NOT_LISTENING';
  throw error;
}
