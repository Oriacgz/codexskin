#!/usr/bin/env node
// codexskin desktop app launcher.
//
// Starts the tokened loopback UI server and, on Windows, the native system
// tray host (WinForms NotifyIcon, in the style of Codex-Dream-Skin's tray
// app). Opens the control window as an Edge/Chrome app-mode window - it looks
// and behaves like a standalone desktop app without Electron.
//
// Flags:
//   --no-open    start server + tray but skip the app window
//   --tray-only  headless desktop app: server + tray, no window
//   --hidden     alias of --tray-only (used by the login autostart shortcut)
//   --port N     prefer this port (default: a free port is chosen)
//   --browser X  force a browser executable (edge|chrome|<path>)

import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUiServer } from "../src/core/ui-server.js";
import { createThemeStore } from "../src/core/store.js";
import { createWatchDeps, runWatchSupervised } from "../src/core/watch.js";
import { dataDir, IS_WIN } from "../src/core/paths.js";
import { writeTrayAssets, spawnTray, stopOrphanTrays } from "../src/core/tray.js";
import { withFileLock, writeJsonAtomic } from '../src/core/atomic.js';


const args = process.argv.slice(2);
const noOpen = args.includes("--no-open");
const trayOnly = args.includes("--tray-only") || args.includes("--hidden");
const noWatch = args.includes("--no-watch");
const noTray = args.includes('--no-tray');
const portFlagIdx = args.indexOf("--port");
const preferredPort = portFlagIdx !== -1 ? Number(args[portFlagIdx + 1]) : 0;
const browserIdx = args.indexOf("--browser");
const browserFlag = browserIdx !== -1 ? args[browserIdx + 1] : null;

// When the control window closes with no tray running, its heartbeat stops
// and this timeout ends the process. With a tray, the tray keeps the app
// alive (its menu needs the server) and only an explicit Quit ends it.
const IDLE_TIMEOUT_MS = 30 * 1000;
// If no window ever checks in (browser failed to open) and there is no tray,
// the app exits after this grace period instead of lingering forever.
const FIRST_WINDOW_GRACE_MS = 120 * 1000;

function die(message) {
  console.error(`codexskin-ui: ${message}`);
  process.exit(1);
}

// --- Browser discovery (Windows: Edge is always present on Win10/11) --------

function candidateBrowsers() {
  if (browserFlag) return [browserFlag];
  if (IS_WIN) {
    return [
      String(process.env.EDGE ?? ""),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    ].filter(Boolean);
  }
  return [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findBrowser() {
  for (const candidate of candidateBrowsers()) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function openControlWindow(url) {
  const browser = await findBrowser();
  const child = browser
    ? spawn(browser, [`--app=${url}`, `--user-data-dir=${path.join(dataDir(), '.ui-profile')}`, '--no-first-run', '--window-size=1120,860'], { detached: true, stdio: 'ignore', windowsHide: false })
    : IS_WIN ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('open', [url], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
}

// --- Main ----------------------------------------------------------------
// No top-level await: the SEA bundle targets CJS.

async function main() {
  await fs.mkdir(dataDir(), { recursive: true });
  // Single instance: if a live desktop app is already running (its tokened
  // server answers), just open its control window and exit. Without this, a
  // second launch would lose the tray-mutex race and shut down confusingly.
  const runtimeStatePath = path.join(dataDir(), "ui-runtime.json");
  try {
    const existing = JSON.parse(await fs.readFile(runtimeStatePath, "utf8"));
    const base = `http://127.0.0.1:${existing.port}/t/${existing.token}`;
    const ping = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(1_500), redirect: 'error' });
    if (ping.ok) {
      if (!trayOnly && !noOpen) {
        await fetch(`${base}/open-window`, { method: "POST", signal: AbortSignal.timeout(5_000), redirect: 'error' }).catch(() => {});
      }
      console.log("codexskin-ui: already running");
      process.exit(0);
    }
  } catch {
    // Not running (or state unreadable): continue with a fresh instance.
  }

  const {
    server, token, isQuitRequested, isTrayQuitRequested, lastWindowHeartbeatAt,
  } = createUiServer({ openWindow: openControlWindow });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/t/${token}/app`;
  console.log(url);

  // Runtime state so `codexskin desktop --quit` (and single-instance launch)
  // can find the tokened server. Lives in the user's own data dir; same-user
  // processes are within the trust boundary anyway (the token only fences
  // other users).
  await writeJsonAtomic(runtimeStatePath, {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  // --- Native tray host (Windows) ------------------------------------------
  // A previous run may have crashed and left a tray whose server is gone
  // (it would also hold the single-instance mutex); clear it first.
  if (IS_WIN && !noTray) {
    const removed = await stopOrphanTrays();
    if (removed > 0) console.log(`codexskin-ui: stopped ${removed} orphan tray host(s)`);
  }
  let tray = null;
  if (IS_WIN && !noTray) {
    try {
      const assets = await writeTrayAssets();
      tray = await spawnTray({
        ps1Path: assets.ps1Path,
        port,
        token,
        logFile: path.join(dataDir(), "tray.log"),
      });
    } catch (error) {
      console.error(`codexskin-ui: tray host unavailable (${error?.message ?? error}); continuing without tray`);
    }
  }

  // --- Control window (app-mode browser) ------------------------------------
  if (!noOpen && !trayOnly) {
    await openControlWindow(url);
  }

  let closing = false;

  // --- Built-in watcher ------------------------------------------------------
  // The desktop app keeps the skin applied on its own: re-apply when Codex
  // re-renders and (after asking once, via the
  // consent bridge) restart a normally-launched Codex so ANY launch gets the
  // skin. This replaces the separate `codexskin watch` service for app users.
  if (!noWatch) {
    try {
      const watchLogPath = path.join(dataDir(), "watch.log");
      const store = createThemeStore(path.join(dataDir(), "themes"));
      const deps = createWatchDeps({
        store,
        autoLaunch: true,
        relaunchClosed: false,
        startupGraceMs: 60_000,
        restartRunning: false,
        intervalMs: 3_000,
        log: (message) => {
          console.log(`[watch] ${message}`);
          fs.appendFile(watchLogPath, `[${new Date().toISOString()}] ${message}\n`).catch(() => {});
        },
      });
      runWatchSupervised(deps, { shouldStop: () => closing || isQuitRequested() }).catch((error) => {
        console.error(`codexskin-ui: watcher ended (${error?.message ?? error})`);
      });
    } catch (error) {
      console.error(`codexskin-ui: watcher unavailable (${error?.message ?? error})`);
    }
  }

  function shutdown(code, reason) {
    if (closing) return;
    closing = true;
    clearInterval(poll);
    if (reason) console.log(`codexskin-ui: exiting (${reason})`);
    try {
      server.close();
    } catch {}
    fs.rm(runtimeStatePath, { force: true }).finally(() => process.exit(code));
  }

  const startedAt = Date.now();
  // Quit conditions, in order: UI/tray quit request; then liveness. A live
  // tray keeps the app running regardless of the window (closing the window
  // just closes the UI; the tray menu can reopen it). Without a tray the app
  // lives only while the control window does. If the tray host dies we fall
  // back to window-only mode instead of killing the app out from under it.
  const poll = setInterval(() => {
    if (isQuitRequested()) return shutdown(0, "quit requested");
    if (tray && isTrayQuitRequested()) return shutdown(0, "tray quit requested");
    if (tray && !tray.isAlive()) {
      console.log("codexskin-ui: tray host exited; switching to window-only mode");
      tray = null;
    }
    if (tray) return;
    const beat = lastWindowHeartbeatAt();
    if (trayOnly) return shutdown(0, "tray exited and windowless mode requested");
    if (beat === 0) {
      if (Date.now() - startedAt > FIRST_WINDOW_GRACE_MS) {
        return shutdown(0, "no window opened");
      }
      return;
    }
    if (Date.now() - beat > IDLE_TIMEOUT_MS) return shutdown(0, "window closed (idle)");
  }, 500);

  process.on("SIGINT", () => shutdown(0, "signal"));
  process.on("SIGTERM", () => shutdown(0, "signal"));
}

withFileLock(path.join(dataDir(), 'ui-start.lock'), main).catch((error) => {
  console.error(`codexskin-ui: ${error?.message ?? error}`);
  process.exit(1);
});

// Expected stream failures are handled at their source. Unexpected failures
// use Node's fatal error handling instead of continuing with unknown state.
