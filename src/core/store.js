// Validated theme store with coordinated installs and crash recovery.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { importThemePackage } from './package.js';
import { normalizeTheme } from './theme.js';
import { validateSafeCss } from './safe-css.js';
import { detectImageMedia,inspectImage } from './image.js';
import { withFileLock, writeJsonAtomic } from './atomic.js';
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function contentFingerprint({ theme, image, css }) {
  return createHash('sha256').update(JSON.stringify(theme)).update('\0').update(image.bytes).update('\0').update(css ?? '').digest('hex');
}
const validId = id => typeof id === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) && id.length <= 64;
const copyPayload = payload => ({ ...payload, theme: structuredClone(payload.theme) });
function assertId(id) { if (!validId(id)) throw new Error(`unsafe theme id: ${id}`); }
async function exists(file) { try { await fs.access(file); return true; } catch (error) { if(error.code==='ENOENT') return false; throw error; } }
export function createThemeStore(themesDir) {
  const cache = new Map();
  const registryFile = id => path.join(themesDir, `${id}.json`);
  async function readEntry(id) {
    assertId(id);
    const stat = await fs.lstat(registryFile(id));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error(`theme ${id}: invalid registry file`);
    const entry = JSON.parse(await fs.readFile(registryFile(id), 'utf8'));
    if (entry.id !== id || !Array.isArray(entry.files)) throw new Error(`theme ${id}: invalid registry (re-import it)`);
    return entry;
  }
  async function registry() {
    const entries=[];
    for(const name of (await fs.readdir(themesDir)).sort()) {
      const id=name.slice(0,-5);
      if(!name.endsWith('.json') || !validId(id)) continue;
      try { entries.push(await readEntry(id)); } catch { entries.push({id,name:id,broken:true}); }
    }
    return entries;
  }
  async function recover() {
    const mergeJournal=path.join(themesDir,'.merge-transaction.json');
    if(await exists(mergeJournal)){
      const journal=JSON.parse(await fs.readFile(mergeJournal,'utf8'));
      if(!Array.isArray(journal.ids)||journal.ids.some(id=>!validId(id))||new Set(journal.ids).size!==journal.ids.length||!/^\.stage-merge-[a-z0-9-]+$/.test(journal.stage))throw new Error('Invalid backup merge journal');
      for(const id of journal.ids){assertId(id);await fs.rm(path.join(themesDir,id),{recursive:true,force:true});await fs.rm(registryFile(id),{force:true});cache.delete(id);}
      await fs.rm(path.join(themesDir,journal.stage),{recursive:true,force:true});await fs.rm(mergeJournal,{force:true});
    }
    for (const name of await fs.readdir(themesDir)) {
      if (!/^\.transaction-[a-z0-9.-]+\.json$/.test(name)) continue;
      const file=path.join(themesDir,name), journal=JSON.parse(await fs.readFile(file,'utf8'));
      assertId(journal.id);
      if (!/^\.stage-[a-z0-9.-]+$/.test(journal.stage) || !/^\.old-[a-z0-9.-]+$/.test(journal.backup)) throw new Error('invalid install journal');
      const dest=path.join(themesDir,journal.id), backup=path.join(themesDir,journal.backup), stage=path.join(themesDir,journal.stage);
      let committed=false;
      try { committed=(await readEntry(journal.id)).transactionId===journal.next.transactionId; } catch {}
      if (!committed) {
        if (await exists(backup)) { await fs.rm(dest,{recursive:true,force:true});await fs.rename(backup,dest); }
        else if (!journal.hadOld && !(await exists(stage))) await fs.rm(dest,{recursive:true,force:true});
        if(journal.previous) await writeJsonAtomic(registryFile(journal.id),journal.previous);
        else await fs.rm(registryFile(journal.id),{force:true});
      }
      await fs.rm(stage,{recursive:true,force:true});await fs.rm(backup,{recursive:true,force:true});await fs.rm(file,{force:true});
      cache.delete(journal.id);
    }
  }
  async function locked(action) {
    return withFileLock(path.join(themesDir,'.store.lock'),async()=>{await recover();return action();});
  }
  async function load(id) {
    assertId(id);
    const entry=await readEntry(id),dir=path.join(themesDir,id);
    const directoryStat = await fs.lstat(dir);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`theme ${id}: payload directory must not be a link`);
    const names=await fs.readdir(dir);
    const imageName=names.find(name=>/^background\.(png|jpe?g|webp)$/i.test(name));
    if(!imageName) throw new Error(`theme ${id} is missing its background image`);
    const declared=entry.files.map(file=>file.name);
    if(declared.length!==new Set(declared).size || names.length!==declared.length
      || !declared.includes('theme.json') || !declared.includes(imageName)
      || names.some(name=>!declared.includes(name))
      || declared.some(name=>!['theme.json','theme.css',imageName].includes(name))) throw new Error(`theme ${id}: undeclared or missing payload (re-import it)`);
    const stats=await Promise.all(names.map(name=>fs.lstat(path.join(dir,name))));
    if(stats.some(stat=>!stat.isFile() || stat.isSymbolicLink())) throw new Error(`theme ${id}: payload must contain regular files`);
    if(stats.some((stat,index)=>stat.size>(names[index]===imageName?10*1024*1024:names[index]==='theme.css'?262144:1024*1024))) throw new Error(`theme ${id}: payload exceeds size limits (re-import it)`);
    const signature=JSON.stringify([entry,stats.map(stat=>[stat.size,stat.mtimeMs,stat.ctimeMs,stat.ino])]);
    if(cache.get(id)?.signature===signature) return copyPayload(cache.get(id).payload);
    const buffers=new Map(await Promise.all(names.map(async name=>[name,await fs.readFile(path.join(dir,name))])));
    for(const file of entry.files) {
      if(sha256(buffers.get(file.name))!==file.sha256) throw new Error(`theme ${id}: ${file.name} does not match its installed checksum (re-import it)`);
    }
    const theme=normalizeTheme(JSON.parse(buffers.get('theme.json').toString('utf8')));
    if(theme.id!==id) throw new Error(`theme ${id}: theme id mismatch`);
    const image=buffers.get(imageName),mime=detectImageMedia(image);
    const extension=imageName.split('.').at(-1).toLowerCase();
    const expected=extension==='png'?'image/png':extension==='webp'?'image/webp':'image/jpeg';
    if(mime!==expected) throw new Error(`theme ${id}: invalid background image`);
    inspectImage(image);
    theme.image=imageName;
    const css=buffers.has('theme.css')?validateSafeCss(buffers.get('theme.css').toString('utf8')):null;
    const payload={theme,css,dataUrl:`data:${mime};base64,${image.toString('base64')}`};
    // Bound retained image data to the most recently loaded themes.
    if (cache.size >= 4 && !cache.has(id)) cache.delete(cache.keys().next().value);
    cache.set(id,{signature,payload});return copyPayload(payload);
  }
  return {
    async list() { return locked(async()=>{
      const out=[];
      for(const entry of await registry()) {
        try {
          const dir=path.join(themesDir,entry.id),directoryStat=await fs.lstat(dir);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('invalid payload directory');
          const names=await fs.readdir(dir),manifestStat=await fs.lstat(path.join(dir,'theme.json'));
          if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1024 * 1024) throw new Error('invalid theme manifest');
          const image=names.find(name=>/^background\.(png|jpe?g|webp)$/i.test(name));
          if(!image || !names.includes('theme.json')) throw new Error('missing files');
          out.push({...entry,files:{id:entry.id,theme:JSON.parse(await fs.readFile(path.join(dir,'theme.json'),'utf8')),image:path.join(dir,image),css:names.includes('theme.css')?path.join(dir,'theme.css'):null}});
        } catch {out.push({...entry,broken:true});}
      }
      return out;
    }); },
    async get(id) {assertId(id);const entries=await this.list();const entry=entries.find(item=>item.id===id);if(!entry) throw new Error(`theme ${id} is not installed`);return entry;},
    async loadPayload(id) {return locked(()=>load(id));},
    async mergePackages(buffers) {
      // Validate every package before staging or mutating the collection.
      const packages=buffers.map(bytes=>importThemePackage(bytes,{trustedKeys:null,requireSignature:false}));
      if(new Set(packages.map(pkg=>pkg.theme.id)).size!==packages.length)throw new Error('Duplicate backup IDs');
      return locked(async()=>{
        const additions=[],skipped=[];
        for(const pkg of packages){if(await exists(registryFile(pkg.theme.id))||await exists(path.join(themesDir,pkg.theme.id)))skipped.push(pkg.theme.id);else additions.push(pkg);}
        if(!additions.length)return {added:[],skipped};
        const stageName='.stage-merge-'+randomUUID(),stage=path.join(themesDir,stageName),journal=path.join(themesDir,'.merge-transaction.json');
        await fs.mkdir(stage);let recorded=false;
        try{
          for(const pkg of additions){
            const {theme,image,css}=pkg,dir=path.join(stage,theme.id);await fs.mkdir(dir);const files=[];
            async function put(name,bytes){await fs.writeFile(path.join(dir,name),bytes,{mode:0o600});files.push({name,sha256:sha256(bytes),bytes:bytes.length});}
            await put('theme.json',Buffer.from(JSON.stringify({...theme,image:image.name},null,2)));await put(image.name,image.bytes);if(css!==null)await put('theme.css',Buffer.from(css));
            await writeJsonAtomic(path.join(stage,theme.id+'.json'),{id:theme.id,name:theme.name,fingerprint:contentFingerprint(pkg),transactionId:randomUUID(),installedAt:new Date().toISOString(),source:pkg.meta?.source??'codexskin-simple',meta:pkg.meta??null,files});
          }
          const ids=additions.map(pkg=>pkg.theme.id);await writeJsonAtomic(journal,{ids,stage:stageName});recorded=true;
          for(const id of ids){await fs.rename(path.join(stage,id),path.join(themesDir,id));await fs.rename(path.join(stage,id+'.json'),registryFile(id));cache.delete(id);}
          await fs.rm(journal,{force:true});return {added:ids,skipped};
        }catch(error){if(recorded)await recover();throw error;}
        finally{await fs.rm(stage,{recursive:true,force:true});}
      });
    },
    async installFromZip(zipBuffer,options={}) {
      const pkg=importThemePackage(zipBuffer,options),{theme,image,css}=pkg,fingerprint=contentFingerprint(pkg);
      return locked(async()=>{
        let previous=null;try {previous=await readEntry(theme.id);} catch {}
        if(previous?.fingerprint===fingerprint) {
          try {await load(theme.id);return {installed:false,theme,meta:pkg.meta??null,reason:'identical content already installed'};} catch { /* repair damaged payload */ }
        }
        const suffix=randomUUID(),stageName=`.stage-${theme.id}-${suffix}`,backupName=`.old-${theme.id}-${suffix}`;
        const stage=path.join(themesDir,stageName),dest=path.join(themesDir,theme.id),backup=path.join(themesDir,backupName);
        const journalFile=path.join(themesDir,`.transaction-${theme.id}.json`);
        await fs.mkdir(stage);
        let journalWritten=false;
        try {
          const written=[];
          async function put(name,bytes){await fs.writeFile(path.join(stage,name),bytes,{mode:0o600});written.push({name,sha256:sha256(bytes),bytes:bytes.length});}
          await put('theme.json',Buffer.from(JSON.stringify({...theme,image:image.name},null,2)));
          await put(image.name,image.bytes);if(css!==null) await put('theme.css',Buffer.from(css));
          const entry={id:theme.id,name:theme.name,fingerprint,transactionId:suffix,installedAt:new Date().toISOString(),source:pkg.meta?.source??'codexskin-simple',meta:pkg.meta??null,files:written};
          const hadOld=await exists(dest);
          await writeJsonAtomic(journalFile,{id:theme.id,stage:stageName,backup:backupName,hadOld,previous,next:entry});journalWritten=true;
          if(hadOld) await fs.rename(dest,backup);
          await fs.rename(stage,dest);
          await writeJsonAtomic(registryFile(theme.id),entry);
          await fs.rm(backup,{recursive:true,force:true});await fs.rm(journalFile,{force:true});cache.delete(theme.id);
          return {installed:true,theme,meta:pkg.meta??null};
        } catch(error) {if(journalWritten) await recover();throw error;}
        finally {await fs.rm(stage,{recursive:true,force:true});}
      });
    },
    async remove(id) {assertId(id);return locked(async()=>{await fs.rm(path.join(themesDir,id),{recursive:true,force:true});await fs.rm(registryFile(id),{force:true});cache.delete(id);});},
  };
}
