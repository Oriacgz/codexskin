// System integration for `codexskin watch`: generate the artifacts needed for
// watch mode to start at login.
//
//  macOS:   launchd LaunchAgent plist (RunAtLoad + KeepAlive, throttled).
//  Windows: a per-user Scheduled Task (ONLOGON) that runs a VBS hidden shim,
//           which runs a logging batch wrapper around `node codexskin watch`.
//           Optional PowerShell tray host for Start/Stop/Status/Quit.
//
// Nothing in this module touches the OS by itself. The CLI writes the files and
// runs the registration commands; `--print` mode renders everything without
// writing or registering, so users can inspect it first.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IS_MAC, IS_WIN } from "./paths.js";

export const SERVICE_LABEL = "cc.codexskin.watch";
export const WINDOWS_TASK_ID = "codexskin-watch";

function defaultCliPath() {
  // <repo>/src/core/service.js -> <repo>/bin/codexskin.mjs
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/codexskin.mjs");
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Resolve the watch command line: { node, args, cwd }.
 */
export function buildWatchCommand(options = {}) {
  if (options.themeId !== undefined && (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(options.themeId) || options.themeId.length > 64)) {
    throw new Error('service: invalid theme id');
  }
  if (options.intervalMs !== undefined && (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0)) {
    throw new Error('service: interval must be a positive integer');
  }
  const binDir = path.dirname(process.execPath);
  const node = path.join(binDir, `node${IS_WIN ? ".exe" : ""}`);
  const cli = path.resolve(options.cliPath ?? defaultCliPath());
  const args = [cli, "watch", "--keep-alive"];
  if (options.themeId) args.push("--theme", options.themeId);
  if (options.noLaunch) args.push("--no-launch");
  if (options.intervalMs) args.push("--interval", String(options.intervalMs));
  // Headless service cannot ask; only run with consent granted (auto), or
  // explicitly disabled (--no-restart). Default: consent-gated on.
  if (options.noRestart) args.push("--no-restart");
  else if (options.restart) args.push("--restart");
  return { node, args, cwd: path.dirname(cli) };
}

// --- macOS: launchd LaunchAgent ---------------------------------------------

/**
 * Build the LaunchAgent plist. RunAtLoad starts at login; KeepAlive restarts
 * the loop if it exits (with ThrottleInterval as the backoff).
 */
export function buildLaunchdPlist(options = {}) {
  const { node, args, cwd } = buildWatchCommand(options);
  const label = options.label ?? SERVICE_LABEL;
  const logPath = options.logPath
    ?? path.join(os.homedir(), "Library", "Logs", "codexskin", "watch.log");
  const dataDir = options.dataDir
    ?? path.join(os.homedir(), "Library", "Application Support", "codexskin");
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const programArgs = [node, ...args];

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs.map((a) => `      <string>${xmlEscape(a)}</string>`).join("\n")}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(cwd)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
      <key>CODEXSKIN_HOME</key>
      <string>${xmlEscape(dataDir)}</string>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>LowPriorityIO</key>
    <true/>
  </dict>
</plist>
`;
  return { label, plist, plistPath, logPath, dataDir };
}

// --- Windows: scheduled task + hidden launcher --------------------------------

/**
 * Build the Windows artifacts. The task action is `wscript.exe <vbs>`; the VBS
 * runs the batch wrapper with a hidden window; the batch logs and runs watch.
 */
export function buildWindowsTask(options = {}) {
  const { node, args, cwd } = buildWatchCommand(options);
  const taskId = options.taskId ?? WINDOWS_TASK_ID;
  const installDir = options.installDir ?? path.join(os.homedir(), ".codexskin-service");
  const logPath = path.join(installDir, "watch.log");
  const batchPath = path.join(installDir, "codexskin-watch.cmd");
  const vbsPath = path.join(installDir, "codexskin-watch-hidden.vbs");
  if (![node, cwd, logPath, batchPath, ...args].every(value => !/["%\r\n]/.test(value))) {
    throw new Error('service: Windows command paths and arguments cannot contain quotes, percent signs, or newlines');
  }

  const quoted = args.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a));
  const nodeArgs = quoted.join(" ");

  const cmd = [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    "rem codexskin watch - generated by `codexskin service install`; do not edit",
    `cd /d "${cwd}"`,
    `echo === codexskin watch start %DATE% %TIME% === >> "${logPath}"`,
    `"${node}" ${nodeArgs} >> "${logPath}" 2>&1`,
    `echo === codexskin watch exit %ERRORLEVEL% %DATE% %TIME% === >> "${logPath}"`,
    "",
  ].join("\r\n");

  // In VBS, "" inside a string literal is an escaped quote, so the run line is
  //   sh.Run "cmd /c ""<batchPath>"", 0, False
  // which executes: cmd /c "<batchPath>" hidden, not waiting.
  const vbs = [
    "' codexskin watch - hidden launcher (generated; do not edit)",
    "Set sh = CreateObject(\"WScript.Shell\")",
    `sh.Run "cmd /c ""${batchPath}""", 0, True`,
    "",
  ].join("\n");

  // The task action string. wscript suppresses any console; the VBS in turn
  // hides the batch console and waits for watch to exit so task status is
  // accurate. Quoted once for paths with spaces.
  const taskAction = `wscript.exe "${vbsPath}"`;

  const schtasksArgs = [
    "/Create",
    "/F",
    "/TN", taskId,
    "/TR", taskAction,
    "/SC", "ONLOGON",
    "/RL", "LIMITED",
  ];

  return {
    taskId,
    installDir,
    batchPath,
    vbsPath,
    logPath,
    taskAction,
    schtasksArgs,
    files: {
      [batchPath]: cmd,
      [vbsPath]: vbs,
    },
  };
}

/**
 * Build the optional PowerShell tray host. It is NOT registered anywhere by
 * default - the user may copy it into their Startup folder.
 */
export function buildTrayScript(options = {}) {
  const installDir = options.installDir ?? path.join(os.homedir(), ".codexskin-service");
  const taskId = options.taskId ?? WINDOWS_TASK_ID;
  const trayPath = path.join(installDir, "codexskin-tray.ps1");

  const ps = `# codexskin tray host (generated by \`codexskin service install --tray\`; do not edit)
# Silent tray icon with Start / Stop / Status / Quit for the watch task.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$taskId = '${String(taskId).replace(/'/g, "''")}'

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Text = "codexskin watch"
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add("&Start watch", $null, {
    param($sender, $event)
    Start-ScheduledTask -TaskName $taskId -ErrorAction SilentlyContinue
}) | Out-Null
$menu.Items.Add("S&top watch", $null, {
    param($sender, $event)
    Stop-ScheduledTask -TaskName $taskId -ErrorAction SilentlyContinue
}) | Out-Null
$menu.Items.Add("S&tatus", $null, {
    param($sender, $event)
    $t = Get-ScheduledTask -TaskName $taskId -ErrorAction SilentlyContinue
    $state = if ($t) { [string]$t.State } else { "NotInstalled" }
    [System.Windows.Forms.MessageBox]::Show($state, "codexskin watch") | Out-Null
}) | Out-Null
$menu.Items.Add("&Quit tray", $null, {
    param($sender, $event)
    $icon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
}) | Out-Null
$icon.ContextMenuStrip = $menu

$context = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($context)
$icon.Dispose()
`;
  return { trayPath, trayScript: ps };
}

// --- Registration / unregistration (executed by the CLI) ----------------------

export function macLoadCommand(label = SERVICE_LABEL) {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  return { cmd: "launchctl", args: ["load", "-w", plistPath], plistPath };
}

export function macUnloadCommand(label = SERVICE_LABEL) {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  return { cmd: "launchctl", args: ["unload", "-w", plistPath], plistPath };
}

export function windowsRegisterCommand(task) {
  return { cmd: "schtasks", args: task.schtasksArgs };
}

export function windowsUnregisterCommand(taskId = WINDOWS_TASK_ID) {
  return { cmd: "schtasks", args: ["/Delete", "/TN", taskId, "/F"] };
}

/**
 * Run a registration command (spawn, wait, capture). Used by the CLI only -
 * this performs the actual system change and reports result honestly.
 */
export async function runRegistration({ cmd, args }) {
  const result = await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return result;
}

// --- Status -----------------------------------------------------------------

export async function serviceStatus() {
  if (IS_MAC) {
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    const installed = existsSync(plistPath);
    let loaded = false;
    if (installed) {
      const out = await runRegistration({ cmd: "launchctl", args: ["list", SERVICE_LABEL] });
      loaded = out.code === 0;
    }
    return { platform: "macos", label: SERVICE_LABEL, plistPath, installed, loaded };
  }
  if (IS_WIN) {
    const task = buildWindowsTask({});
    const out = await runRegistration({ cmd: "schtasks", args: ["/Query", "/TN", task.taskId, "/FO", "LIST"] });
    return {
      platform: "windows",
      taskId: task.taskId,
      vbsPath: task.vbsPath,
      batchPath: task.batchPath,
      installed: out.code === 0,
      raw: out.stdout,
    };
  }
  return { platform: process.platform, installed: false };
}
