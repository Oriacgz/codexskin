// Guarded Codex launcher.
//
// Rules:
//  - Codex is ALWAYS launched with a dedicated user-data-dir (a codexskin-owned
//    profile). We never pass flags to the user's default profile, and we never
//    touch the app bundle itself. The dedicated profile keeps the user logged
//    in across skin sessions without racing a running default-profile instance.
//  - If Codex is already reachable on our debug port, we reuse it.
//  - If Codex is running WITHOUT our debug port, we refuse and tell the user -
//    no killing processes, no double instance fights.
//
// The debug port is derived from a stable per-user value (seeded), persisted in
// state.json so doctor/apply/restore always agree on the same port.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { listTargets, isCodexTarget } from "./cdp.js";
import { dataDir, IS_MAC, IS_WIN } from "./paths.js";
import { loadState, updateState } from "./state.js";

const run = promisify(execFile);

export const DEBUG_PORT_FALLBACK = 9223;

async function portReachable(port) {
  try {
    return (await listTargets(port, { timeoutMs: 1_500 })).some(isCodexTarget);
  } catch {
    return false;
  }
}

function profileDir() {
  return path.join(dataDir(), "codex-profile");
}

async function persistPort(port) {
  const state = await loadState();
  if (state.debugPort === port) return;
  await updateState(current => ({ ...current, debugPort: validPort(current.debugPort) ? current.debugPort : port }));
}

function validPort(port) { return Number.isInteger(port) && port >= 1 && port <= 65535; }

export async function resolvePort() {
  const state = await loadState();
  if (validPort(state.debugPort)) {
    return state.debugPort;
  }
  // First run: try fallback, then scan a small deterministic range upward.
  let port = DEBUG_PORT_FALLBACK;
  for (let i = 0; i < 10; i += 1) {
    if (!(await portReachable(port))) break;
    port += 1;
  }
  await persistPort(port);
  return (await loadState()).debugPort;
}

/**
 * Is Codex currently running with our debug port?
 */
export async function isCodexReachable(port) {
  return portReachable(port);
}

/**
 * Launch Codex with the dedicated profile + debug port and wait for CDP.
 * Throws with actionable text if Codex is already running without the port.
 */
export async function launchCodex(appInfo, exePath, port, { timeoutMs = 30_000 } = {}) {
  if (process.env.CODEXSKIN_NO_LAUNCH === '1') throw new Error('auto-launch is disabled in this environment');
  if (!exePath) throw new Error("Codex executable not found (run `codexskin doctor`)");

  // Reject double launches: if any Codex instance is already up (without our
  // port), Electron will just focus the existing one and our flags are lost.
  if (IS_WIN) {
    const running = await findWindowsCodexPids();
    if (running.length > 0 && !(await portReachable(port))) {
      const error = new Error(
        "Codex is already running without the debug port. "
        + "Quit Codex completely (system tray too), then run `codexskin apply` again.",
      );
      // Machine-readable: the UI/tray offer a restart flow on this code.
      error.code = "CODEX_RUNNING_NO_PORT";
      throw error;
    }
  }

  await fs.mkdir(profileDir(), { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir()}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  // macOS: launch the inner binary so flags are honored reliably.
  const cmd = IS_MAC ? await macBinaryPath(appInfo) : exePath;
  if (!cmd) throw new Error("could not locate the Codex binary inside the app bundle");

  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    // This is the GUI app itself, not a console helper. Hiding it can leave
    // Electron invisible until the user activates its tray icon.
    windowsHide: false,
  });
  child.unref();
  let spawnError;
  child.on('error', error => { spawnError = error; });

  // Wait until CDP answers.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`could not launch Codex: ${spawnError.message}`);
    if (await portReachable(port)) return { port, pid: child.pid ?? null };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Codex did not expose CDP on 127.0.0.1:${port} within ${timeoutMs / 1000}s. `
    + "Check `codexskin doctor`.",
  );
}

async function macBinaryPath(appInfo) {
  // The bundle has exactly one main binary (helpers end in _helper / are in
  // subdirectories). Prefer known product names, then first non-helper entry.
  try {
    const entries = (await fs.readdir(appInfo.binDir)).sort();
    const known = entries.find((n) => n === "Codex" || n === "ChatGPT");
    if (known) return path.join(appInfo.binDir, known);
    const main = entries.find((n) => !n.includes("_helper") && !n.endsWith(" Helper"));
    if (main) return path.join(appInfo.binDir, main);
  } catch {
    // fall through
  }
  return null;
}

async function findWindowsCodexPids() {
  if (!IS_WIN) return [];
  try {
    const rows = await Promise.all(['ChatGPT.exe', 'Codex.exe'].map(async name => {
      const { stdout } = await run('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { timeout: 5_000, windowsHide: true });
      return stdout.split(/\r?\n/).filter(line => /^"(?:ChatGPT|Codex)\.exe",/i.test(line));
    }));
    return rows.flat();
  } catch {
    return [];
  }
}

/**
 * Is any Codex process running (regardless of how it was launched)?
 */
export async function isCodexRunning() {
  if (IS_WIN) return (await findWindowsCodexPids()).length > 0;
  return false; // macOS: detection handled by discovery/CDP; do not guess.
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Close a running Codex instance gracefully, escalating to force only if the
 * process ignores the close request. Never used silently: callers must tell
 * the user (or ask) before closing their app. Returns { closed }.
 */
export async function closeCodex({ graceMs = 3_500, runCommand = run, listProcesses = findWindowsCodexPids } = {}) {
  if (process.env.CODEXSKIN_NO_LAUNCH === '1') throw new Error('closing Codex is disabled in this environment');
  if (!IS_WIN) throw new Error("closing Codex is only supported on Windows");
  const pids = async () => (await listProcesses())
    .map(parseWindowsProcessPid)
    .filter(Boolean);

  let current = await pids();
  if (current.length === 0) return { closed: false, forced: false };

  // Graceful: WM_CLOSE to each pid. A windowed app usually exits; some builds
  // minimize to tray instead, so we re-check and only then force.
  for (let round = 0; round < 2 && current.length > 0; round += 1) {
    for (const pid of current) {
      try { await runCommand("taskkill", ["/PID", pid], { timeout: 5_000, windowsHide: true }); } catch { /* already gone */ }
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      current = await pids();
      if (current.length === 0) return { closed: true, forced: false };
      await sleep(250);
    }
  }

  current = await pids();
  if (current.length > 0) {
    for (const pid of current) {
      try { await runCommand("taskkill", ["/PID", pid, "/F"], { timeout: 5_000, windowsHide: true }); } catch { /* gone */ }
    }
    await sleep(400);
  }
  const remaining = await pids();
  return { closed: remaining.length === 0, forced: true };
}

export function parseWindowsProcessPid(line) {
  return /^"[^\"]+","(\d+)"(?:,|$)/.exec(line.trim())?.[1] ?? null;
}
