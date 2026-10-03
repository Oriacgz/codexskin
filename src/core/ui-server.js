import { activateCodexWindow } from './launch-window.js';
import { createCustomTheme, defaultSettings, validateSettings, exportThemePackage } from './customization.js';
// Local UI server for the codexskin desktop interface.
//
// Security model:
//  - binds 127.0.0.1 only, with a per-launch random token in the URL path
//  - any request without the correct token -> 404 (indistinguishable from
//    "no server"). Same-user processes can read the runtime token and are trusted.
//  - JSON/zip body caps enforced before parsing; import limited to 33 MiB
//    (zip.js enforces the same limit structurally)
//
// Endpoints (all under /t/<token>/):
//   GET  app            -> the embedded single-file interface
//   GET  ping           -> heartbeat ("ok")
//   GET  state          -> { themes, activeThemeId, codexReachable, codexAppFound, platform }
//   POST import/<name>  -> .zip/.codextheme bytes; validates + installs; auto-applies when nothing is active
//   POST apply/<id>     -> apply an installed theme (launches Codex when needed)
//   POST remove/<id>    -> delete an installed theme
//   POST restore        -> remove the skin from the running renderer
//   GET  image/<id>     -> theme background as bytes (UI preview)
//   POST quit           -> shuts the server down (window close / Quit button)

import http from "http";
import fs from 'node:fs/promises';
import {buildCollectionBackup,validateCollectionBackup} from './backup.js';
import {buildDiagnosticReport,diagnosticLogErrors,classifyError} from './diagnostics.js';
import {assertDebugPortSafe,inspectDebugListener} from './debug-security.js';
import crypto from "crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";
import { createThemeStore } from "./store.js";
import { applyTheme, restoreSkin, checkCompatibility } from "./apply.js";
import {
  answerRestartConsent,
  autoRestartEnabled,
  readRestartConsent,
  setAutoRestart,
} from "./consent.js";
import { closeCodex, isCodexReachable, isCodexRunning, launchCodex, resolvePort } from "./launch.js";
import { codexExecutable, dataDir, discoverCodexApp } from "./paths.js";
import { loadState, updateState } from "./state.js";
import {createScheduler,validateSchedule,manualSchedulePause,scheduleSlot} from './schedule.js';
import {checkUpdates} from './updates.js';
import { loginAutostartEnabled, setLoginAutostart } from "./tray.js";
import { renderApp } from "./ui-page.js";

const MAX_IMPORT_BYTES = 33 * 1024 * 1024;

function json(res, code, payload) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Launch (or reuse) a skinned Codex. When a normal (un-skinned) Codex is
 * running, it is closed first - a second launch would only focus it. This is
 * the explicit "Launch skinned Codex" action (tray menu / UI button).
 */
async function launchSkinnedCodex() {
  const port = await resolvePort();
  await assertDebugPortSafe(port,{requireListener:false,fresh:true});
  if (await isCodexReachable(port)) return { launched: false, port, ...await activateCodexWindow(port) };
  if (process.env.CODEXSKIN_NO_LAUNCH === "1") {
    throw new Error("auto-launch is disabled in this environment");
  }
  const app = await discoverCodexApp();
  if (!app) {
    throw new Error("Codex desktop app not found; install Codex/ChatGPT desktop");
  }
  const exe = await codexExecutable(app);
  if (await isCodexRunning()) {
    if (!(await closeCodex()).closed) throw new Error('could not close the running Codex');
    await sleep(600);
  }
  await launchCodex(app, exe, port);
  return { launched: true, port, ...await activateCodexWindow(port) };
}

/**
 * Create the UI server (not listening yet). Returns { server, token }.
 * After `server.listen(0)`, read `server.address().port`.
 */
export function createUiServer({ openWindow = async () => {}, apply = applyTheme } = {}) {
  const token = crypto.randomBytes(16).toString("base64url");
  const store = createThemeStore(path.join(dataDir(), "themes"));
  // Queue manual and scheduled applications so resume cannot overwrite a click.
  let applyQueue=Promise.resolve();
  function enqueueUi(action){const work=applyQueue.then(action);applyQueue=work.catch(()=>{});return work;}
  function applyUi(id,options={}){
    return enqueueUi(async()=>{
      const state=await loadState();
      if(options.onlyIfInactive&&state.activeThemeId)return;
      if(options.onlyIfActive&&state.activeThemeId!==id)return;
      if(options.scheduled&&(quitRequested||!state.schedule?.enabled||state.schedulePausedUntil>Date.now()||scheduleSlot(state.schedule)?.themeId!==id))return;
      return apply(store,id,options);
    });
  }
  // HTML parsing normalizes CRLF. Hash the exact script browsers execute.
  const appHtml = renderApp({ token }).replace(/\r\n?/g, '\n');
  const script = appHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const scriptHash = crypto.createHash('sha256').update(script).digest('base64');
  let quitRequested = false;
  let trayQuitRequested = false;
  let windowToken = 0; // bumped whenever a window is (re)opened via /open-window
  let lastPageHeartbeat = 0; // Date.now() of the last FRESH page heartbeat
  let statusPromise;
  let pendingBackup=null, backupExpiryTimer, restoring=false;
  const recentErrors=[];
  const protectedSockets = new WeakSet();
  let statusExpires = 0;
  function systemStatus() {
    if (!statusPromise || Date.now() >= statusExpires) {
      statusExpires = Date.now() + 2_000;
      statusPromise = Promise.all([discoverCodexApp(), isCodexRunning(), loginAutostartEnabled()])
        .catch(error => { statusPromise = null; throw error; });
    }
    return statusPromise;
  }

  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error(`upload too large (max ${limit} bytes)`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`
      || (req.headers.origin && req.headers.origin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    // A client that hangs up mid-request/response must not take the whole
    // desktop app down (unhandled 'error' on the stream = process crash).
    req.on("error", () => {});
    res.on("error", () => {});
    if (!protectedSockets.has(req.socket)) {
      protectedSockets.add(req.socket);
      req.socket.on('error', () => {});
    }
    let parts;
    try {
      const url = new URL(req.url, `http://127.0.0.1:${req.socket.localPort}`);
      parts = url.pathname.split("/").filter(Boolean);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    // Token gate: everything must live under /t/<token>/...
    if (parts[0] !== "t" || parts[1] !== token) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    // parts = ["t", <token>, <verb>, ...args] - arg i lives at parts[3 + i].
    const seg = (i) => decodeURIComponent(parts[3 + i] ?? "");
    const route = parts.slice(2).join("/");

    try {
      if (route === "app" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(appHtml);
        return;
      }

      if (route === "ping" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end("ok");
        return;
      }

      // Heartbeat from the control window's page. The page sends the window
      // token it last saw; a stale value means an older (replaced) window is
      // beating, which must not count as a live window. The response carries
      // the current token so a fresh page syncs on its second beat.
      if (route === "window-heartbeat" && req.method === "POST") {
        let since = NaN;
        try {
          const body = await readBody(req, 4 * 1024);
          if (body.length > 0) since = Number(JSON.parse(body.toString("utf8"))?.since);
        } catch { /* treat as stale */ }
        const stale = !(Number.isFinite(since) && since >= windowToken);
        if (!stale) lastPageHeartbeat = Date.now();
        json(res, 200, { ok: true, stale, token: windowToken });
        return;
      }

      // Tray "Open window": returns the app URL; the tray opens it with the
      // default handler. Bumps the window token so an old window's heartbeat
      // (if any) reads as stale.
      if (route === "open-window" && req.method === "POST") {
        windowToken += 1;
        await openWindow(`http://127.0.0.1:${server.address().port}/t/${token}/app`);
        json(res, 200, { ok: true, url: `/t/${token}/app` });
        return;
      }

      if(route==='backup/export'&&req.method==='POST'){
        const bytes=await buildCollectionBackup(store,await loadState());res.writeHead(200,{'Content-Type':'application/zip'});res.end(bytes);return;
      }
      if(route==='backup/review'&&req.method==='POST'){
        const validated=validateCollectionBackup(await readBody(req,32*1024*1024));
        const installed=new Set((await store.list()).map(t=>t.id));
        pendingBackup={...validated,id:crypto.randomUUID(),expires:Date.now()+10*60*1000};
        clearTimeout(backupExpiryTimer);
        backupExpiryTimer=setTimeout(()=>{pendingBackup=null;},10*60*1000);backupExpiryTimer.unref();
        json(res,200,{ok:true,reviewId:pendingBackup.id,themes:validated.packages.map(p=>({name:p.theme.name,conflict:installed.has(p.theme.id)})),selectedThemeAvailable:Boolean(validated.selectedThemeId)});return;
      }
      if(route==='backup/restore'&&req.method==='POST'){
        const input=JSON.parse((await readBody(req,4096)).toString('utf8'));
        if(restoring)throw new Error('A backup restore is already running');
        if(!pendingBackup||input.reviewId!==pendingBackup.id||Date.now()>pendingBackup.expires)throw new Error('Backup review expired; choose the file again');
        if(typeof input.restoreSelection!=='boolean')throw new Error('Invalid selected-theme preference');
        restoring=true;const backup=pendingBackup;pendingBackup=null;clearTimeout(backupExpiryTimer);
        await enqueueUi(async()=>{
        try{
          const recovery=await buildCollectionBackup(store,await loadState()),dir=path.join(dataDir(),'backups');await fs.mkdir(dir,{recursive:true});
          const temp=path.join(dir,'recovery-'+crypto.randomUUID()+'.tmp'),dest=path.join(dir,'pre-restore-latest.zip');
          try{await fs.writeFile(temp,recovery,{mode:0o600});await fs.rename(temp,dest);}finally{await fs.rm(temp,{force:true});}
          const result=await store.mergePackages(backup.packages.map(p=>p.zip));
          let preferenceError=false;
          try{await updateState(state=>{const overrides={...state.themeOverrides};for(const id of result.added)delete overrides[id];return {...state,themeOverrides:overrides,...(input.restoreSelection&&backup.selectedThemeId?{activeThemeId:backup.selectedThemeId,schedulePausedUntil:manualSchedulePause(state)}:{})};});}catch{preferenceError=true;}
          json(res,200,{ok:true,added:result.added.length,skipped:result.skipped.length,recoveryAvailable:true,preferenceError});
        }finally{restoring=false;}
        });
        return;
      }
      if(route==='backup/recovery'&&req.method==='POST'){
        const bytes=await fs.readFile(path.join(dataDir(),'backups','pre-restore-latest.zip'));res.writeHead(200,{'Content-Type':'application/zip'});res.end(bytes);return;
      }
      if(route==='diagnostics'&&req.method==='GET'){
        const themes=await store.list(),state=await loadState(),port=await resolvePort();
        const [app,running]=await systemStatus(),reachable=await isCodexReachable(port);
        let compatibility=null;
        if(reachable&&state.activeThemeId){try{compatibility=await checkCompatibility(port,state.activeThemeId);}catch(error){recentErrors.push({code:classifyError(error.message)});if(recentErrors.length>20)recentErrors.shift();}}
        const report=buildDiagnosticReport({found:app,running,reachable,themes,selected:state.activeThemeId,compatibility,recentErrors,logErrors:await diagnosticLogErrors(dataDir()),debuggerBinding:await inspectDebugListener(port,{fresh:true})});
        json(res,200,{ok:true,report});return;
      }
      if (route === "compatibility" && req.method === "GET") {
        const state = await loadState();
        if (!state.activeThemeId) {
          json(res, 200, { windows: [], warnings: ['Select and apply a theme before checking compatibility.'] });
        } else {
          json(res, 200, await checkCompatibility(await resolvePort(), state.activeThemeId));
        }
        return;
      }

      if(route==='updates/check'&&req.method==='POST'){json(res,200,await checkUpdates());return;}
      if(route.startsWith('favorite/')&&req.method==='POST'){
        const id=seg(0);await store.get(id);
        const input=JSON.parse((await readBody(req,4096)).toString());
        if(typeof input.favorite!=='boolean')throw new Error('Invalid favorite');
        await updateState(s=>({...s,favoriteThemeIds:input.favorite?[...new Set([...(Array.isArray(s.favoriteThemeIds)?s.favoriteThemeIds:[]),id])]: (s.favoriteThemeIds??[]).filter(v=>v!==id)}));
        json(res,200,{ok:true});return;
      }
      if(route==='settings/schedule'&&req.method==='POST'){
        const schedule=validateSchedule(JSON.parse((await readBody(req,4096)).toString()));
        if(schedule.enabled)for(const id of [schedule.dayThemeId,schedule.nightThemeId]){const entry=await store.get(id);if(entry.broken)throw new Error('Repair scheduled theme first');}
        await updateState({schedule,schedulePausedUntil:0});json(res,200,{ok:true});void scheduleTick();return;
      }
      if (route === "state" && req.method === "GET") {
        const themes = await store.list();
        const state = await loadState();
        const port = await resolvePort();
        const reachable = await isCodexReachable(port);
        const [app, running, autostart] = await systemStatus();
        json(res, 200, {
          themes: themes.map((t) => ({
            id: t.id,
            name: t.name,
            source: t.source ?? "codexskin-simple",
            active: state.activeThemeId === t.id,
            favorite: Array.isArray(state.favoriteThemeIds)&&state.favoriteThemeIds.includes(t.id),
            broken: Boolean(t.broken),
            revision: t.fingerprint ?? t.installedAt,
            customized: Boolean(state.themeOverrides?.[t.id]),
          })),
          activeThemeId: state.activeThemeId ?? null,
          schedule: state.schedule??{enabled:false},
          schedulePausedUntil: state.schedulePausedUntil??0,
          codexReachable: reachable,
          codexRunning: running,
          codexAppFound: Boolean(app),
          autostartEnabled: autostart,
          autoRestartEnabled: await autoRestartEnabled(),
          platform: process.platform,
        });
        return;
      }

      // Watch-consent bridge: the background watcher asked "may I restart a
      // normally-launched Codex?". The UI page delivers the ask (read clears
      // it) and posts the user's answer back.
      if (route === "consent/restart" && req.method === "GET") {
        const pending = await readRestartConsent();
        json(res, 200, { ok: true, pending });
        return;
      }

      if (route === "consent/restart" && req.method === "POST") {
        try {
          const body = await readBody(req, 4 * 1024);
          const allowed = JSON.parse(body.toString("utf8"))?.allow === true;
          const result = await answerRestartConsent({ allowed });
          json(res, 200, { ok: true, ...result });
        } catch (error) {
          json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }

      // Auto-restart preference ("restart Codex to keep the skin applied").
      if (route === "settings/auto-restart" && req.method === "POST") {
        try {
          const body = await readBody(req, 4 * 1024);
          const enabled = JSON.parse(body.toString("utf8"))?.enabled === true;
          await setAutoRestart(enabled);
          json(res, 200, { ok: true, autoRestartEnabled: enabled });
        } catch (error) {
          json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }

      // Explicit "Launch skinned Codex" (UI button + tray menu): starts Codex
      // with the guarded profile, closing a normal instance when present.
      if (route === "launch-codex" && req.method === "POST") {
        try {
          const result = await launchSkinnedCodex();
          json(res, 200, { ok: true, ...result });
        } catch (error) {
          json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }

      // Tray convenience: apply the active (or first) theme without a body.
      if (route === "apply-active" && req.method === "POST") {
        // Body (optional): { restart: true } - same meaning as apply/<id>.
        let restart = false;
        try {
          const body = await readBody(req, 4 * 1024);
          if (body.length > 0) restart = JSON.parse(body.toString("utf8"))?.restart === true;
        } catch { /* empty/invalid body: no restart */ }
        try {
          const state = await loadState();
          const themes = await store.list();
          const id = state.activeThemeId ?? themes.find((t) => !t.broken)?.id;
          if (!id) throw new Error("no theme installed; import one first");
          const result = await applyUi(id, { restartRunning: restart });
          json(res, 200, { ok: true, ...result });
        } catch (error) {
          json(res, 200, {
            ok: false,
            error: String(error?.message ?? error),
            code: error?.code ?? undefined,
          });
        }
        return;
      }

      // Login autostart (Startup-folder shortcut; per-user, no admin).
      if (route.startsWith("autostart/") && req.method === "POST") {
        const action = seg(0);
        if (action !== "enable" && action !== "disable") {
          json(res, 200, { ok: false, error: "autostart route is enable|disable" });
          return;
        }
        try {
          // Target: the SEA exe itself, or node + the ui entry in dev.
          const targetExe = process.execPath;
          const args = [ ...(isSea() ? [] : [
            fileURLToPath(new URL("../../bin/codexskin-ui.mjs", import.meta.url)),
          ]), '--hidden' ];
          const result = await setLoginAutostart({
            enabled: action === "enable",
            targetExe,
            args,
          });
          statusPromise = null;
          json(res, 200, {
            ok: result.ok,
            enabled: action === "enable",
            lnkPath: result.lnkPath,
            error: result.ok ? undefined : result.detail,
          });
        } catch (error) {
          json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }

      if (parts[2] === 'theme' && ['duplicate','export'].includes(parts[4]) && req.method === 'POST') {
        const id = seg(0), payload = await store.loadPayload(id), state = await loadState();
        const settings = state.themeOverrides?.[id] || payload.theme.settings
          ? validateSettings({...defaultSettings(payload.theme, payload.css ?? ''),...state.themeOverrides?.[id]}) : null;
        const duplicate = parts[4] === 'duplicate';
        const input = duplicate ? JSON.parse((await readBody(req,4096)).toString('utf8')) : {};
        const result = exportThemePackage(payload, settings, { duplicate, name: duplicate ? input.name : undefined });
        if (duplicate) {
          await store.installFromZip(result.zip,{trustedKeys:null,requireSignature:false});
          json(res,200,{ok:true,theme:{id:result.theme.id,name:result.theme.name}});
        } else {
          res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="codexskin-theme.codextheme"'});
          res.end(result.zip);
        }
        return;
      }
      if (route === 'create' && req.method === 'POST') {
        const input = JSON.parse((await readBody(req, 15 * 1024 * 1024)).toString('utf8'));
        const created = createCustomTheme(input);
        const result = await store.installFromZip(created.zip, { trustedKeys: null, requireSignature: false });
        await updateState(state => ({ ...state, themeOverrides: { ...state.themeOverrides, [result.theme.id]: created.settings } }));
        json(res, 200, { ok: true, theme: { id: result.theme.id, name: result.theme.name } });
        return;
      }
      if (parts[2] === 'theme' && parts[4] === 'settings' && ['GET','POST'].includes(req.method)) {
        const id = seg(0);
        const payload = await store.loadPayload(id);
        const defaults = defaultSettings(payload.theme, payload.css ?? '');
        if (req.method === 'GET') {
          const state = await loadState();
          json(res, 200, { ok: true, name: payload.theme.name, defaults, settings: state.themeOverrides?.[id] ? validateSettings({...defaults,...state.themeOverrides[id]}) : defaults });
          return;
        }
        const input = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        const settings = input.reset === true ? null : validateSettings(input);
        const state = await updateState(state => {
          const overrides = { ...state.themeOverrides };
          if (settings) overrides[id] = settings; else delete overrides[id];
          return { ...state, themeOverrides: overrides };
        });
        let applied = false, applyError = null;
        if (state.activeThemeId === id && await isCodexReachable(await resolvePort())) {
          try { applied = Boolean(await applyUi(id, { autoLaunch: false, onlyIfActive:true })); }
          catch (error) { applyError = error.message; }
        }
        json(res, 200, { ok: true, applied, applyError });
        return;
      }

      if (route.startsWith("import/") && req.method === "POST") {
        const fileName = seg(0) || "theme.zip";
        if (!/\.(zip|codextheme)$/i.test(fileName)) {
          json(res, 200, { ok: false, error: "only .zip and .codextheme files are supported" });
          return;
        }
        const bytes = await readBody(req, MAX_IMPORT_BYTES);
        if (bytes.length === 0) throw new Error("empty upload");
        const result = await store.installFromZip(bytes, { trustedKeys: null, requireSignature: false });

        // Auto-apply policy: when no theme is active yet (first import, or
        // after restore), the freshly imported theme applies immediately.
        // restartRunning: a Codex the user opened normally is closed and
        // relaunched skinned - importing your first theme should just work.
        let autoApplied = false;
        let restarted = false;
        let applyError = null;
        const state = await loadState();
        if (!state.activeThemeId) {
          try {
            const applied = await applyUi(result.theme.id, {
              onlyIfInactive:true,
              restartRunning: req.headers['x-codexskin-restart'] === 'true' || await autoRestartEnabled(),
            });
            autoApplied = Boolean(applied);
            restarted = applied?.restarted === true;
          } catch (error) {
            applyError = String(error?.message ?? error);
          }
        }
        json(res, 200, {
          ok: true,
          installed: result.installed,
          theme: { id: result.theme.id, name: result.theme.name },
          autoApplied,
          restarted,
          applyError,
        });
        return;
      }

      if (route.startsWith("apply/") && req.method === "POST") {
        const id = seg(0);
        // Body (optional): { restart: true } closes a normal (un-skinned)
        // Codex and relaunches it with the skin profile before applying.
        let restart = false;
        try {
          const body = await readBody(req, 4 * 1024);
          if (body.length > 0) restart = JSON.parse(body.toString("utf8"))?.restart === true;
        } catch { /* empty/invalid body: no restart */ }
        try {
          const result = await applyUi(id, { restartRunning: restart });
          json(res, 200, { ok: true, ...result });
        } catch (error) {
          json(res, 200, {
            ok: false,
            error: String(error?.message ?? error),
            code: error?.code ?? undefined,
          });
        }
        return;
      }

      if (route.startsWith("remove/") && req.method === "POST") {
        const id = seg(0);
        if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) throw new Error("bad theme id");
        await enqueueUi(async()=>{
        const state = await loadState();
        if (state.activeThemeId === id && await isCodexReachable(await resolvePort())) await restoreSkin(await resolvePort());
        await store.remove(id);
        await updateState(state => { const overrides = { ...state.themeOverrides }; delete overrides[id]; return { ...state, favoriteThemeIds:(state.favoriteThemeIds??[]).filter(v=>v!==id),schedule:state.schedule?.dayThemeId===id||state.schedule?.nightThemeId===id?{enabled:false}:state.schedule,themeOverrides: overrides, activeThemeId: state.activeThemeId === id ? null : state.activeThemeId }; });
        });
        json(res, 200, { ok: true });
        return;
      }

      if (route === "restore" && req.method === "POST") {
        const outcome=await enqueueUi(async()=>{
        await updateState(s=>({...s,schedulePausedUntil:manualSchedulePause(s)}));
        const port = await resolvePort();
        let outcome = { attempted: false };
        if (await isCodexReachable(port)) {
          const restore = await restoreSkin(port);
          outcome = { attempted: true, ...restore };
        }
        await updateState(s=>({...s,activeThemeId:null,restoredAt:new Date().toISOString(),schedulePausedUntil:manualSchedulePause(s)}));
        return outcome;
        });
        json(res, 200, { ok: true, ...outcome });
        return;
      }

      if (route.startsWith("image/") && req.method === "GET") {
        const id = seg(0);
        if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) throw new Error("bad theme id");
        const { dataUrl } = await store.loadPayload(id);
        const [metadata, encoded] = dataUrl.split(',');
        const mime = metadata.slice(5, -7);
        const bytes = Buffer.from(encoded, 'base64');
        res.writeHead(200, { "content-type": mime, "cache-control": "private, max-age=30" });
        res.end(bytes);
        return;
      }

      if (route === "quit" && req.method === "POST") {
        // Acknowledge quit before the desktop loop can close the server.
        res.once('finish', () => { quitRequested = true; trayQuitRequested = true; });
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { ok: false, error: "unknown route" });
    } catch (error) {
      recentErrors.push({code:classifyError(error?.message??error)});if(recentErrors.length>20)recentErrors.shift();
      json(res, 200, { ok: false, error: String(error?.message ?? error) });
    }
  });

  const scheduleTick=createScheduler({load:loadState,apply:id=>applyUi(id,{autoLaunch:false,restartRunning:false,scheduled:true})});
  let scheduleTimer;
  server.on('listening',()=>{void scheduleTick();scheduleTimer=setInterval(()=>{if(!quitRequested)void scheduleTick();},15000);scheduleTimer.unref();});
  server.on('close',()=>{clearInterval(scheduleTimer);clearTimeout(backupExpiryTimer);pendingBackup=null;});
  return {
    server,
    token,
    isQuitRequested: () => quitRequested,
    isTrayQuitRequested: () => trayQuitRequested,
    currentWindowToken: () => windowToken,
    lastWindowHeartbeatAt: () => lastPageHeartbeat,
  };
}
