#!/usr/bin/env node
// codexskin CLI.
//
// Commands:
//   codexskin doctor              - check platform, Codex install, CDP port
//   codexskin list                - list installed themes
//   codexskin import <file.zip>   - validate + install a theme package
//   codexskin apply [themeId]     - launch Codex (if needed) and apply a theme
//   codexskin verify              - check the active theme is live in the renderer
//   codexskin restore             - remove the skin from the running renderer
//   codexskin remove <themeId>    - delete an installed theme
//   codexskin launch              - launch Codex with the debug port only

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createPublicKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connectCdp } from "../src/core/cdp.js";
import { createWatchDeps, runWatchLoop, runWatchSupervised, WATCH_ACTIONS } from "../src/core/watch.js";
import {
  buildLaunchdPlist,
  buildTrayScript,
  buildWindowsTask,
  macLoadCommand,
  macUnloadCommand,
  runRegistration,
  serviceStatus,
  windowsRegisterCommand,
  windowsUnregisterCommand,
  WINDOWS_TASK_ID,
} from "../src/core/service.js";
import { codexExecutable, dataDir, discoverCodexApp, trustedKeysPath, IS_MAC, IS_WIN } from "../src/core/paths.js";
import { isCodexReachable, launchCodex, resolvePort } from "../src/core/launch.js";
import { applyTheme, restoreSkin, verifySkin } from "../src/core/apply.js";
import {
  buildSignatureEnvelope,
  generateSigningKeyPair,
  loadTrustedKeys,
  parseSignatureEnvelope,
  verifyEnvelopeBytes,
} from "../src/core/trust.js";
import { readZip } from "../src/core/zip.js";
import { buildZip } from "../src/core/zip-write.js";
import {
  buildApplyExpression,
  buildRestoreExpression,
  buildVerifyExpression,
} from "../src/core/payload.js";
import { createThemeStore } from "../src/core/store.js";
import { loadState, updateState } from "../src/core/state.js";

const USAGE = `codexskin - dream skins for the Codex desktop app

Usage:
  codexskin doctor              Check platform, Codex install, CDP reachability
  codexskin list                List installed themes
  codexskin import <zip>        Validate and install a theme package
                                flags: --trusted-keys <file> --require-signature
  codexskin apply [themeId]     Launch Codex if needed and apply a theme
                                flag: --restart (close a normal Codex and relaunch it skinned)
  codexskin verify              Verify the active theme is live in the renderer
  codexskin restore             Remove the skin from the running renderer
  codexskin remove <themeId>    Delete an installed theme
  codexskin ui                  Open the desktop interface (import / apply / restore)
  codexskin desktop             Native desktop app: tray icon (+ control window)
                                flags: --no-window (tray only) --quit (stop a running app)
  codexskin service install     Start watch at login (LaunchAgent / Scheduled Task; --print = dry run)
  codexskin service status      Show whether the service is installed/loaded
  codexskin service uninstall   Remove the service registration and artifacts
  codexskin launch              Launch Codex with the debug port only
  codexskin watch               Keep the active theme applied; relaunch Codex if it exits
                                flags: --interval <ms> --theme <id> --no-launch --keep-alive
                                       --restart (consent-gated) --no-restart
  codexskin keygen <keyId>      Generate an ed25519 signing keypair (--out <dir>)
  codexskin sign-manifest <zip> Sign an official package manifest
                                flags: --key <pem> --key-id <id> --out <zip> --force

Environment:
  CODEXSKIN_HOME                Override the data directory (default per-OS)
  CODEXSKIN_TRUSTED_KEYS        Trusted-keys file (default: <dataDir>/trusted-keys.pem)`;

function print(...args) {
  console.log(...args);
}

function die(message, code = 1) {
  console.error(`codexskin: ${message}`);
  process.exit(code);
}

function themesDirPath() {
  return path.join(dataDir(), "themes");
}

async function getStore() {
  return createThemeStore(themesDirPath());
}

/** Ensure Codex is reachable; launch it with the guarded profile if not. */
async function ensureCodex({ autoLaunch = true } = {}) {
  const port = await resolvePort();
  if (await isCodexReachable(port)) return { port, launched: false };

  if (!autoLaunch) die(`Codex is not reachable on 127.0.0.1:${port}; run \`codexskin apply\` first`);

  const app = await discoverCodexApp();
  if (!app) die("Codex desktop app not found; run `codexskin doctor` for details");
  const exe = await codexExecutable(app);
  const result = await launchCodex(app, exe, port);
  return { port, launched: true, ...result };
}

async function cmdDoctor() {
  const app = await discoverCodexApp();
  const port = await resolvePort();
  const reachable = await isCodexReachable(port);
  const store = await getStore();
  const themes = await store.list();

  let trustInfo = "(no trusted-keys file - official signatures cannot be verified)";
  try {
    const keys = await loadTrustedKeys(trustedKeysPath());
    trustInfo = `${keys.size} key(s): ${[...keys.keys()].join(", ")}`;
  } catch {
    // stays the default note
  }

  print("codexskin doctor");
  print(`  platform        : ${process.platform}`);
  print(`  data dir        : ${dataDir()}`);
  print(`  codex app       : ${app ? `${app.path} (${app.kind})` : "NOT FOUND"}`);
  if (app && process.platform === "win32") print(`  codex exe       : ${app.exe}`);
  print(`  debug port      : ${port}`);
  print(`  codex reachable : ${reachable ? "yes" : "no (will launch on apply)"}`);
  print(`  trusted keys    : ${trustInfo}`);
  print(`  themes installed: ${themes.length}`);
  for (const t of themes) {
    print(`    - ${t.id} (${t.broken ? "BROKEN" : t.name})`);
  }
  if (!app) {
    print("");
    print("  Install Codex desktop, or set CODEXSKIN_HOME if your data dir is custom.");
  }
}

async function cmdList() {
  const store = await getStore();
  const themes = await store.list();
  if (themes.length === 0) {
    print("No themes installed. Import one with: codexskin import <file.zip>");
    return;
  }
  for (const t of themes) {
    print(`${t.broken ? "! " : "  "}${t.id}  ${t.name}${t.broken ? "  (broken install)" : ""}`);
  }
}

/**
 * Parse CLI args: `valueFlags` take a following value, `booleanFlags` are
 * presence-only. Unknown flags die with the usage string.
 */
function parseFlagArgs(rest, valueFlags, booleanFlags = [], usage = "") {
  const positional = [];
  const opts = {};
  const known = new Set([...valueFlags, ...booleanFlags]);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (valueFlags.includes(arg)) {
      i += 1;
      if (i >= rest.length) die(`${arg} requires a value`);
      opts[arg] = rest[i];
    } else if (booleanFlags.includes(arg)) {
      opts[arg] = true;
    } else if (arg.startsWith("--")) {
      die(`unknown flag: ${arg}${usage ? `\n\n${usage}` : ""}`);
    } else {
      positional.push(arg);
    }
  }
  void known;
  return { positional, opts };
}

/**
 * Resolve the trusted-keys set for an import.
 *  - explicit path or required -> must load (clear error if missing)
 *  - otherwise -> load if the default/env file exists, else null (unverified)
 */
async function resolveTrustedKeys(explicitPath, required) {
  const tkPath = explicitPath ?? trustedKeysPath();
  if (explicitPath || required) return loadTrustedKeys(tkPath);
  try {
    await fs.access(tkPath);
  } catch {
    return null;
  }
  return loadTrustedKeys(tkPath);
}

async function cmdImport(rest) {
  const { positional, opts } = parseFlagArgs(
    rest,
    ["--trusted-keys"],
    ["--require-signature"],
    "usage: codexskin import <file.zip> [--trusted-keys <file>] [--require-signature]",
  );
  if (positional.length !== 1) {
    die("usage: codexskin import <file.zip> [--trusted-keys <file>] [--require-signature]");
  }
  const zipPath = positional[0];
  let zipBuffer;
  try {
    zipBuffer = await fs.readFile(zipPath);
  } catch (error) {
    die(`cannot read ${zipPath}: ${error.message}`);
  }
  const trustedKeys = await resolveTrustedKeys(opts["--trusted-keys"], Boolean(opts["--require-signature"]));
  // Full validation happens inside installFromZip (import -> validate -> atomic write).
  const store = await getStore();
  const result = await store.installFromZip(zipBuffer, {
    trustedKeys,
    requireSignature: Boolean(opts["--require-signature"]),
  });
  if (result.installed) {
    print(`Installed theme "${result.theme.name}" (${result.theme.id}).`);
    if (result.meta?.source === "dreamskin-official") {
      const p = result.meta;
      print(`  source       : official DreamSkin.cc package v${p.themeVersion} by ${p.publisher?.displayName ?? p.publisher?.id ?? "unknown"}`);
      print(`  platforms    : ${(p.platforms ?? []).join(", ")}`);
      print(`  capabilities : ${(p.capabilities ?? []).join(", ")}`);
      print(`  min client   : ${p.minClientVersion} (informational)`);
      if (p.signature?.verified) {
        print(`  signature    : VERIFIED (ed25519, keyId ${p.signature.keyId})`);
      } else {
        print("  signature    : none (unsigned package)");
      }
    }
    print("Apply it with: codexskin apply " + result.theme.id);
  } else {
    print(`Theme "${result.theme.name}" already installed (identical content); nothing to do.`);
  }
}

async function cmdApply(rest) {
  const { positional, opts } = parseFlagArgs(
    rest,
    [],
    ["--restart"],
    "usage: codexskin apply [themeId] [--restart]",
  );
  const store = await getStore();
  const themes = await store.list();
  let id = positional[0];
  if (!id) {
    if (themes.length === 0) die("no themes installed; import one first: codexskin import <file.zip>");
    id = themes[0].id;
    print(`No theme specified; using "${themes[0].name}" (${id}).`);
  }
  const record = themes.find((t) => t.id === id);
  if (!record) die(`theme "${id}" is not installed (see: codexskin list)`);
  if (record.broken) die(`theme "${id}" is broken; reinstall it (codexskin import)`);

  // Shared orchestration: guarded launch, optional restart of a normal
  // (un-skinned) Codex, multi-window apply, per-window verification.
  const result = await applyTheme(store, id, {
    restartRunning: Boolean(opts["--restart"]),
    log: print,
  });
  const parts = [`${result.windows} window(s)`];
  if (result.restarted) parts.push("Codex restarted with the skin profile");
  print(`Theme "${record.name}" is live (verified; ${parts.join(", ")}).`);
}

async function cmdVerify() {
  const state = await loadState();
  if (!state.activeThemeId) die("no active theme recorded");
  const port = await resolvePort();
  if (!(await isCodexReachable(port))) die(`Codex not reachable on ${port}; is it running with the skin profile?`);
    const result = await verifySkin(port, state.activeThemeId);
    print(JSON.stringify(result, null, 2));
    process.exitCode = result?.ok ? 0 : 2;
}

async function cmdRestore() {
  const port = await resolvePort();
  if (!(await isCodexReachable(port))) {
    print("Codex is not running with the skin profile; nothing to restore.");
    await updateState({ activeThemeId: null, restoredAt: new Date().toISOString() });
    return;
  }
    const result = await restoreSkin(port);
    print(`Restored official appearance (removed ${result?.removed ?? 0} node(s)).`);
}

async function cmdRemove(themeId) {
  if (!themeId) die("usage: codexskin remove <themeId>");
  const store = await getStore();
  const state = await loadState();
  if (state.activeThemeId === themeId && await isCodexReachable(await resolvePort())) await restoreSkin(await resolvePort());
  await store.remove(themeId);
  await updateState(state => ({ ...state, activeThemeId: state.activeThemeId === themeId ? null : state.activeThemeId }));
  print(`Removed theme ${themeId}.`);
}

async function cmdWatch(rest) {
  const { opts } = parseFlagArgs(
    rest,
    ["--interval", "--theme"],
    ["--no-launch", "--keep-alive", "--restart", "--no-restart"],
    "usage: codexskin watch [--interval <ms>] [--theme <id>] [--no-launch] [--keep-alive] [--restart|--no-restart]",
  );
  const intervalMs = opts["--interval"] ? Number(opts["--interval"]) : undefined;
  if (intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs < 250)) {
    die("--interval must be a number >= 250 (ms)");
  }
  const themeFlag = opts["--theme"] ?? null;
  const autoLaunch = !opts["--no-launch"];
  // Restart of a normally-launched Codex: on by default, gated by consent
  // ("ask" until the user answers once). --no-restart disables entirely.
  const restartRunning = opts["--no-restart"]
    ? false
    : opts["--restart"] ? true : !opts["--no-launch"];

  const store = await getStore();
  if (themeFlag) {
    const themes = await store.list();
    const record = themes.find((t) => t.id === themeFlag);
    if (!record) die(`theme "${themeFlag}" is not installed (see: codexskin list)`);
  }

  print(`Watching (interval ${intervalMs ?? 2000}ms, theme ${themeFlag ?? "active"}, auto-launch ${autoLaunch ? "on" : "off"}, auto-restart ${restartRunning ? "consent-gated" : "off"}). Ctrl+C to stop.`);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const deps = createWatchDeps({ store, themeId: themeFlag, autoLaunch, restartRunning, log: print, intervalMs });
  if (opts["--keep-alive"]) {
    // Supervised mode: used by the service integration; restarts the inner loop
    // when it gives up. Ctrl+C still exits via shouldStop.
    await runWatchSupervised(deps, { shouldStop: () => stopping });
    print("Watch (supervised) ended.");
    return;
  }
  const final = await runWatchLoop(deps, { shouldStop: () => stopping });
  if (final?.action === WATCH_ACTIONS.GAVE_UP) {
    process.exitCode = 2;
  }
  print("Watch ended.");
}

async function cmdLaunch() {
  const { port, launched } = await ensureCodex();
  print(launched ? `Codex launched (CDP on 127.0.0.1:${port}).` : `Codex already running (CDP on 127.0.0.1:${port}).`);
}

async function cmdUi() {
  const uiEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "codexskin-ui.mjs");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [uiEntry], { stdio: "inherit" });
  await new Promise((resolve) => child.on("exit", resolve));
}

const DESKTOP_USAGE = "usage: codexskin desktop [--no-window] [--quit]";

/**
 * `codexskin desktop`: the native desktop app. With --quit, asks any running
 * desktop app (window or tray) to exit via its tokened server; the running
 * app owns the token, so we discover it from the launcher's state file.
 */
async function cmdDesktop(rest) {
  const { opts } = parseFlagArgs(rest, [], ["--no-window", "--quit", "--hidden"], DESKTOP_USAGE);
  const uiEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "codexskin-ui.mjs");
  const { spawn } = await import("node:child_process");

  if (opts["--quit"]) {
    const runtimeStatePath = path.join(dataDir(), "ui-runtime.json");
    let runtime = null;
    try {
      runtime = JSON.parse(await fs.readFile(runtimeStatePath, "utf8"));
    } catch {
      die("codexskin desktop is not running (no runtime state found)", 0);
    }
    const deadline = Date.now() + 5000;
    try {
      await fetch(`http://127.0.0.1:${runtime.port}/t/${runtime.token}/quit`, { method: "POST" });
    } catch { /* already gone */ }
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${runtime.port}/t/${runtime.token}/ping`);
      } catch {
        print("codexskin desktop stopped.");
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    die("the desktop app did not stop in time; it may still be exiting");
  }

  const childArgs = [uiEntry];
  if (opts["--no-window"] || opts["--hidden"]) childArgs.push("--tray-only");
  const child = spawn(process.execPath, childArgs, { stdio: "inherit" });
  await new Promise((resolve) => child.on("exit", resolve));
}

async function cmdService(rest) {
  const action = rest[0];
  const { opts } = parseFlagArgs(
    rest.slice(1),
    ["--theme", "--interval", "--install-dir", "--cli"],
    ["--no-launch", "--no-restart", "--restart", "--print", "--tray"],
    "usage: codexskin service <install|uninstall|status> [--theme <id>] [--interval <ms>] [--no-launch] [--restart|--no-restart] [--print] [--tray]",
  );

  if (action === "status" || (action !== "install" && action !== "uninstall")) {
    const status = await serviceStatus();
    print(JSON.stringify(status, null, 2));
    if (action !== "status") die(`unknown service action: ${action ?? "<missing>"}\n\n${USAGE}`, 1);
    return;
  }

  const serviceOptions = {
    themeId: opts["--theme"],
    intervalMs: opts["--interval"] ? Number(opts["--interval"]) : undefined,
    noLaunch: Boolean(opts["--no-launch"]),
    restart: Boolean(opts["--restart"]),
    noRestart: Boolean(opts["--no-restart"]),
    installDir: opts["--install-dir"],
    cliPath: opts["--cli"],
  };

  if (action === "uninstall") {
    if (IS_MAC) {
      const { label, plist, plistPath } = buildLaunchdPlist(serviceOptions);
      void plist;
      const unload = macUnloadCommand(label);
      const out = await runRegistration(unload);
      print(`launchctl unload: ${out.code === 0 ? "ok" : `failed (${out.stderr.trim() || out.code})`}`);
      await fs.rm(plistPath, { force: true });
      print(`Removed ${plistPath}.`);
    } else if (IS_WIN) {
      const task = buildWindowsTask(serviceOptions);
      const del = windowsUnregisterCommand(task.taskId);
      const out = await runRegistration(del);
      print(`schtasks /Delete: ${out.code === 0 ? "ok" : `failed (${out.stderr.trim() || out.code})`}`);
      if (opts["--tray"]) print("Note: tray host (if running) must be quit from its menu.");
    } else {
      die(`service integration is not supported on ${process.platform}`);
    }
    return;
  }

  // --- install ---
  const dryRun = Boolean(opts["--print"]);
  if (IS_MAC) {
    const built = buildLaunchdPlist(serviceOptions);
    if (dryRun) {
      print(`--- would write ${built.plistPath} ---`);
      print(built.plist);
      print(`--- then: launchctl load -w ${built.plistPath}`);
      return;
    }
    await fs.mkdir(path.dirname(built.plistPath), { recursive: true });
    await fs.mkdir(path.dirname(built.logPath), { recursive: true });
    await fs.writeFile(built.plistPath, built.plist, { mode: 0o644 });
    print(`Wrote ${built.plistPath}.`);
    const load = macLoadCommand(built.label);
    const out = await runRegistration(load);
    if (out.code !== 0) {
      die(`launchctl load failed: ${out.stderr.trim() || out.code}. The plist is written; inspect and load manually.`);
    }
    print(`Loaded LaunchAgent "${built.label}" (starts at login, KeepAlive on).`);
    print(`Log: ${built.logPath}`);
    return;
  }

  if (IS_WIN) {
    const task = buildWindowsTask(serviceOptions);
    if (dryRun) {
      for (const [filePath, content] of Object.entries(task.files)) {
        print(`--- would write ${filePath} ---`);
        print(content);
      }
      const reg = windowsRegisterCommand(task);
      print(`--- would run: ${reg.cmd} ${reg.args.join(" ")}`);
      if (opts["--tray"]) {
        const tray = buildTrayScript({ ...serviceOptions, installDir: task.installDir });
        print(`--- would write ${tray.trayPath} ---`);
        print(tray.trayScript);
      }
      return;
    }
    await fs.mkdir(task.installDir, { recursive: true });
    for (const [filePath, content] of Object.entries(task.files)) {
      await fs.writeFile(filePath, content);
      print(`Wrote ${filePath}.`);
    }
    if (opts["--tray"]) {
      const tray = buildTrayScript({ ...serviceOptions, installDir: task.installDir });
      await fs.writeFile(tray.trayPath, tray.trayScript);
      print(`Wrote ${tray.trayPath} (start it manually or copy to your Startup folder).`);
    }
    const reg = windowsRegisterCommand(task);
    const out = await runRegistration(reg);
    if (out.code !== 0) {
      die(`schtasks /Create failed: ${out.stderr.trim() || out.code}. Files are written; register manually with:\n  ${reg.cmd} ${reg.args.join(" ")}`);
    }
    print(`Registered scheduled task "${task.taskId}" (runs at logon, hidden).`);
    print(`Log: ${task.logPath}`);
    return;
  }

  die(`service integration is not supported on ${process.platform}`);
}

async function cmdKeygen(rest) {
  const { positional, opts } = parseFlagArgs(rest, ["--out"], [], "usage: codexskin keygen <keyId> [--out <dir>]");
  const keyId = positional[0];
  if (!keyId || positional.length !== 1) die("usage: codexskin keygen <keyId> [--out <dir>]");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) die(`invalid keyId: ${keyId}`);

  const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();
  const dir = opts["--out"] ?? ".";
  await fs.mkdir(dir, { recursive: true });
  const privPath = path.join(dir, `${keyId}.private.pem`);
  const pubPath = path.join(dir, `${keyId}.public.pem`);
  try {
    await fs.writeFile(privPath, privateKeyPem, { flag: "wx", mode: 0o600 });
  } catch (error) {
    die(`refusing to overwrite existing ${privPath}`);
  }
  await fs.writeFile(pubPath, publicKeyPem, { flag: "wx", mode: 0o600 });
  print(`Generated ed25519 keypair for keyId "${keyId}":`);
  print(`  private key : ${privPath}  (keep secret, mode 0600)`);
  print(`  public key  : ${pubPath}`);
  print("");
  print(`Trust it locally by adding the public key to ${trustedKeysPath()}:`);
  print(`  keyId: ${keyId}`);
  print("  -----BEGIN PUBLIC KEY-----");
  print("  <paste the contents of the public key file>");
  print("  -----END PUBLIC KEY-----");
}

async function cmdSignManifest(rest) {
  const { positional, opts } = parseFlagArgs(
    rest,
    ["--key", "--key-id", "--out"],
    ["--force"],
    "usage: codexskin sign-manifest <pkg.zip> --key <pem> --key-id <id> [--out <zip>] [--force]",
  );
  if (positional.length !== 1 || !opts["--key"] || !opts["--key-id"]) {
    die("usage: codexskin sign-manifest <pkg.zip> --key <pem> --key-id <id> [--out <zip>] [--force]");
  }
  const zipPath = positional[0];
  const keyPath = opts["--key"];
  const keyId = opts["--key-id"];

  let privateKeyPem;
  try {
    privateKeyPem = await fs.readFile(keyPath, "utf8");
  } catch (error) {
    die(`cannot read private key ${keyPath}: ${error.message}`);
  }
  let zipBuffer;
  try {
    zipBuffer = await fs.readFile(zipPath);
  } catch (error) {
    die(`cannot read ${zipPath}: ${error.message}`);
  }

  const files = readZip(zipBuffer);
  if (!files.has("manifest.json")) die("not an official package: manifest.json missing");
  if (files.has("manifest.sig") && !opts["--force"]) {
    die("package already has manifest.sig; use --force to replace it");
  }

  const manifestBytes = files.get("manifest.json");
  const envelope = buildSignatureEnvelope(manifestBytes, privateKeyPem, keyId);

  // Verify our own signature before writing anything - catches bad keys early.
  const selfKey = createPublicKey(privateKeyPem);
  const parsed = parseSignatureEnvelope(envelope);
  verifyEnvelopeBytes(parsed, manifestBytes, selfKey);

  files.set("manifest.sig", envelope);
  const outPath = opts["--out"] ?? `${zipPath.replace(/\.zip$/i, "")}.signed.zip`;
  await fs.writeFile(outPath, buildZip(files), { flag: "wx", mode: 0o600 });
  print(`Signed manifest of ${zipPath} (ed25519, keyId ${keyId}).`);
  print(`Wrote ${outPath}.`);
  print("Recipients must add your public key to their trusted-keys file to import it with verification.");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "doctor": return cmdDoctor();
    case "list": return cmdList();
    case "import": return cmdImport(rest);
    case "apply": return cmdApply(rest);
    case "verify": return cmdVerify();
    case "restore": return cmdRestore();
    case "remove": return cmdRemove(rest[0]);
    case "watch": return cmdWatch(rest);
    case "ui": return cmdUi(rest);
    case "desktop": return cmdDesktop(rest);
    case "service": return cmdService(rest);
    case "launch": return cmdLaunch();
    case "keygen": return cmdKeygen(rest);
    case "sign-manifest": return cmdSignManifest(rest);
    case "help": case "--help": case "-h": case undefined:
      print(USAGE);
      return command === undefined ? process.exitCode = 1 : undefined;
    default:
      die(`unknown command: ${command}\n\n${USAGE}`);
      return undefined;
  }
}

try {
  await main();
} catch (error) {
  die(error?.message ?? String(error));
}
