// Isolated preview: no Codex launch, watcher, tray, or login registration.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createUiServer } from '../src/core/ui-server.js';
import { createThemeStore } from '../src/core/store.js';
import { saveState } from '../src/core/state.js';
import { SAMPLE_THEMES, buildSampleThemeZip } from '../src/core/sample-themes.js';
process.env.CODEXSKIN_HOME=path.join(import.meta.dirname,'preview-data');
process.env.CODEXSKIN_NO_LAUNCH='1';
await fs.mkdir(process.env.CODEXSKIN_HOME,{recursive:true});
const store=createThemeStore(path.join(process.env.CODEXSKIN_HOME,'themes'));
for(const theme of SAMPLE_THEMES)await store.installFromZip(buildSampleThemeZip(theme));
await saveState({activeThemeId:SAMPLE_THEMES[0].id,autoRestart:false,debugPort:1});
const {server,token}=createUiServer();
await new Promise(r=>server.listen(0,'127.0.0.1',r));
console.log(`http://127.0.0.1:${server.address().port}/t/${token}/app`);
process.on('SIGINT',()=>{server.closeAllConnections();server.close();});
