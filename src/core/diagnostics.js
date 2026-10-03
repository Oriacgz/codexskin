import fs from 'node:fs/promises';
import path from 'node:path';
import metadata from '../../package.json' with {type:'json'};
export function classifyError(message) {
 const text=String(message);
 if(/timeout|timed out/i.test(text))return 'REQUEST_TIMEOUT';
 if(/ENOENT|not found|not installed/i.test(text))return 'FILE_OR_APP_NOT_FOUND';
 if(/EACCES|EPERM|permission|access.*denied/i.test(text))return 'ACCESS_DENIED';
 if(/connect|fetch|ECONN|CDP|websocket|unreachable/i.test(text))return 'CONNECTION_FAILED';
 if(/icon|shortcut|tray/i.test(text))return 'DESKTOP_INTEGRATION_FAILED';
 if(/theme|zip|image|checksum|unsafe|invalid|backup/i.test(text))return 'VALIDATION_FAILED';
 return 'OTHER_ERROR';
}
export async function diagnosticLogErrors(dir) {
 const result=[];
 for(const source of ['watch','tray']){
  let file;
  try{file=await fs.open(path.join(dir,source+'.log'),'r');const size=(await file.stat()).size;const bytes=Buffer.alloc(Math.min(size,32768));await file.read(bytes,0,bytes.length,Math.max(0,size-bytes.length));
   for(const line of bytes.toString('utf8').split(/\r?\n/).filter(line=>/error|failed|timeout|denied/i.test(line)).slice(-10))result.push({source,code:classifyError(line)});
  }catch{/* Missing logs are normal. */}finally{await file?.close();}
 }
 return result;
}
export function buildDiagnosticReport({found,running,reachable,themes,selected,compatibility,recentErrors,logErrors,debuggerBinding}) {
 // Whitelist output fields. Never copy raw errors, paths, names, URLs or account data.
 const warnings=(compatibility?.windows??[]).map((window,index)=>({window:index+1,warningCount:window.warnings?.length??0}));
 const binding=['loopback','unsafe','not-listening','unknown'].includes(debuggerBinding?.status)?debuggerBinding.status:'unknown';
 return {app:'codexskin',version:metadata.version,generatedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,node:process.version,debuggerBinding:{status:binding},connection:{appInstalled:Boolean(found),appRunning:Boolean(running),themeConnection:Boolean(reachable)},collection:{themes:themes.length,broken:themes.filter(t=>t.broken).length,themeSelected:Boolean(selected)},compatibility:{checked:Boolean(compatibility),windows:warnings,generalWarningCount:compatibility?.warnings?.length??0},recentErrors:recentErrors.map(e=>({source:'control-window',code:e.code})),logErrors:logErrors.map(e=>({source:e.source,code:e.code})),privacy:'Paths, theme names, account data, connection tokens and raw logs are excluded.'};
}
