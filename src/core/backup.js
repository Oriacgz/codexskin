import {buildZip} from './zip-write.js';
import {readZip,ZIP_LIMITS} from './zip.js';
import {importThemePackage} from './package.js';
import {defaultSettings,validateSettings,exportThemePackage} from './customization.js';

export async function buildCollectionBackup(store,state) {
 const themes=await store.list();
 if(themes.length>31)throw new Error('Backup supports up to 31 themes; export extra themes separately');
 const files=new Map(),ids=[];let total=0;
 for(const entry of themes){
  if(entry.broken)throw new Error('Repair or remove broken themes before backing up');
  const payload=await store.loadPayload(entry.id);
  const settings=state.themeOverrides?.[entry.id]||payload.theme.settings?validateSettings({...defaultSettings(payload.theme,payload.css??''),...state.themeOverrides?.[entry.id]}):null;
  const zip=exportThemePackage(payload,settings).zip;total+=zip.length;
  if(total>ZIP_LIMITS.maxArchiveBytes-65536)throw new Error('Backup exceeds 32 MiB; export large themes separately');
  files.set('themes/'+entry.id+'.codextheme',zip);ids.push(entry.id);
 }
 files.set('backup.json',Buffer.from(JSON.stringify({format:'codexskin-backup',version:1,themeIds:ids,preferences:{selectedThemeId:ids.includes(state.activeThemeId)?state.activeThemeId:null}})));
 const bytes=buildZip(files);readZip(bytes);return bytes;
}
export function validateCollectionBackup(bytes) {
 const files=readZip(bytes),manifestBytes=files.get('backup.json');
 if(!manifestBytes||manifestBytes.length>65536)throw new Error('Missing or oversized backup manifest');
 const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));
 if(manifest?.format!=='codexskin-backup'||manifest.version!==1||!Array.isArray(manifest.themeIds)||manifest.themeIds.length>31||new Set(manifest.themeIds).size!==manifest.themeIds.length)throw new Error('Unsupported backup format');
 if(!manifest.preferences||typeof manifest.preferences!=='object'||Array.isArray(manifest.preferences)||Object.keys(manifest.preferences).some(key=>key!=='selectedThemeId'))throw new Error('Invalid backup preferences');
 const packages=[];let remaining=ZIP_LIMITS.maxTotalBytes;
 for(const id of manifest.themeIds){
  if(typeof id!=='string'||id.length>64||! /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id))throw new Error('Unsafe backup theme ID');
  const zip=files.get('themes/'+id+'.codextheme');if(!zip)throw new Error('Backup is missing a theme');
  const pkg=importThemePackage(zip,{trustedKeys:null,requireSignature:false,maxExpandedBytes:remaining});remaining-=pkg.expandedBytes;if(pkg.theme.id!==id)throw new Error('Backup theme ID mismatch');
  packages.push({zip,theme:pkg.theme});
 }
 if(files.size!==packages.length+1)throw new Error('Unexpected backup files');
 const selected=manifest.preferences?.selectedThemeId??null;
 if(selected!==null&&!manifest.themeIds.includes(selected))throw new Error('Invalid selected theme in backup');
 return {packages,selectedThemeId:selected};
}
export {ZIP_LIMITS};
