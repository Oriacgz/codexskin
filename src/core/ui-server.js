import { activateCodexWindow } from './launch-window.js';
import { createCustomTheme, defaultSettings, validateSettings } from './customization.js';
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
export function createUiServer({ openWindow = async () => {} } = {}) {
  const token = crypto.randomBytes(16).toString("base64url");
  const store = createThemeStore(path.join(dataDir(), "themes"));
  const appHtml = renderApp({ token });
  const script = appHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const scriptHash = crypto.createHash('sha256').update(script).digest('base64');
  let quitRequested = false;
  let trayQuitRequested = false;
  let windowToken = 0; // bumped whenever a window is (re)opened via /open-window
  let lastPageHeartbeat = 0; // Date.now() of the last FRESH page heartbeat
  let statusPromise;
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

      if (route === "compatibility" && req.method === "GET") {
        const state = await loadState();
        if (!state.activeThemeId) {
          json(res, 200, { windows: [], warnings: ['Select and apply a theme before checking compatibility.'] });
        } else {
          json(res, 200, await checkCompatibility(await resolvePort(), state.activeThemeId));
        }
        return;
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
            broken: Boolean(t.broken),
            revision: t.fingerprint ?? t.installedAt,
            customized: Boolean(state.themeOverrides?.[t.id]),
          })),
          activeThemeId: state.activeThemeId ?? null,
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
          const result = await applyTheme(store, id, { restartRunning: restart });
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
          json(res, 200, { ok: true, name: payload.theme.name, defaults, settings: state.themeOverrides?.[id] ? validateSettings(state.themeOverrides[id]) : defaults });
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
          try { await applyTheme(store, id, { autoLaunch: false }); applied = true; }
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
            const applied = await applyTheme(store, result.theme.id, {
              restartRunning: req.headers['x-codexskin-restart'] === 'true' || await autoRestartEnabled(),
            });
            autoApplied = true;
            restarted = applied.restarted === true;
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
          const result = await applyTheme(store, id, { restartRunning: restart });
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
        const state = await loadState();
        if (state.activeThemeId === id && await isCodexReachable(await resolvePort())) await restoreSkin(await resolvePort());
        await store.remove(id);
        await updateState(state => { const overrides = { ...state.themeOverrides }; delete overrides[id]; return { ...state, themeOverrides: overrides, activeThemeId: state.activeThemeId === id ? null : state.activeThemeId }; });
        json(res, 200, { ok: true });
        return;
      }

      if (route === "restore" && req.method === "POST") {
        const port = await resolvePort();
        let outcome = { attempted: false };
        if (await isCodexReachable(port)) {
          const restore = await restoreSkin(port);
          outcome = { attempted: true, ...restore };
        }
        await updateState({ activeThemeId: null, restoredAt: new Date().toISOString() });
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
        quitRequested = true;
        trayQuitRequested = true;
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { ok: false, error: "unknown route" });
    } catch (error) {
      json(res, 200, { ok: false, error: String(error?.message ?? error) });
    }
  });

  return {
    server,
    token,
    isQuitRequested: () => quitRequested,
    isTrayQuitRequested: () => trayQuitRequested,
    currentWindowToken: () => windowToken,
    lastWindowHeartbeatAt: () => lastPageHeartbeat,
  };
}
