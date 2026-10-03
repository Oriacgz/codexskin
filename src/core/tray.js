// Native Windows desktop integration: system-tray host + icon artifacts.
//
// The reference desktop app (Codex-Dream-Skin windows/scripts/tray-dream-skin.ps1)
// ships its GUI as a WinForms NotifyIcon tray app: right-click menu with
// Apply/Pause/Import/Restore, balloon notifications, single instance per user
// (named mutex), and a Startup-folder shortcut for login autostart.
// codexskin mirrors that pattern - no Electron, no WebView shell, no admin:
//
//   buildIco()                - dependency-free 32bpp DIB ICO writer.
//   trayIconRgba()            - the codexskin glyph as RGBA pixels.
//   writeTrayAssets()         - materialize icon + generated tray host on disk.
//   spawnTray()               - start the detached PowerShell tray process.
//   stopOrphanTrays()         - kill tray hosts left over from crashed runs.
//   buildStartupShortcutCmd() - "Launch at login" .lnk creation/removal script.
//
// The tray host talks to the codexskin UI server (ui-server.js) over the
// tokened loopback routes, so tray and app window stay in sync. When its
// server stays unreachable the host exits by itself - no zombie trays.

import { execFile } from "node:child_process";
import {taskbarPropertySource} from "./windows-taskbar.js";
import {logoIcoBase64} from './brand-assets.js';
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { dataDir, IS_WIN } from "./paths.js";

const run = promisify(execFile);

export const TRAY_MUTEX = "Local\\codexskin.tray";
export const TRAY_PS1_NAME = "codexskin-tray.ps1";
export const TRAY_ICON_NAME = "codexskin-tray.ico";

/**
 * Write a Windows ICO with ONE classic 32-bpp DIB frame (no PNG frame).
 * PNG-framed icons trip up GDI+'s System.Drawing.Icon on some sizes; a plain
 * BI_RGB 32bpp frame loads everywhere. Bottom-up rows, BGRA + AND mask.
 */
export function buildIco(size, rgba) {
  if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error("ico: size must be 1..256");
  if (!Buffer.isBuffer(rgba)) throw new Error("ico: rgba buffer required");
  if (rgba.length !== size * size * 4) throw new Error("ico: buffer size mismatch");

  const xorStride = size * 4;
  const andStride = Math.ceil(size / 32) * 4; // 1bpp mask rows, dword-aligned
  const xorSize = xorStride * size;
  const andSize = andStride * size;

  const dib = Buffer.alloc(40 + xorSize + andSize);
  // BITMAPINFOHEADER
  dib.writeUInt32LE(40, 0);        // biSize
  dib.writeInt32LE(size, 4);       // biWidth
  dib.writeInt32LE(size * 2, 8);   // biHeight (XOR + AND masks, bottom-up)
  dib.writeUInt16LE(1, 12);        // biPlanes
  dib.writeUInt16LE(32, 14);       // biBitCount
  dib.writeUInt32LE(0, 16);        // biCompression = BI_RGB
  dib.writeUInt32LE(xorSize, 20);  // biSizeImage (XOR mask)
  // XOR mask: rows bottom-up, BGRA.
  for (let y = 0; y < size; y += 1) {
    const srcRow = (size - 1 - y) * size * 4;
    const dstRow = 40 + y * xorStride;
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      dib[d] = rgba[s + 2];     // B
      dib[d + 1] = rgba[s + 1]; // G
      dib[d + 2] = rgba[s];     // R
      dib[d + 3] = rgba[s + 3]; // A
    }
  }
  // AND mask stays all-zero: alpha channel carries transparency.

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry[2] = 0; // palette colors
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);           // planes
  entry.writeUInt16LE(32, 6);          // bpp
  entry.writeUInt32LE(dib.length, 8);  // bytes in resource
  entry.writeUInt32LE(22, 12);         // image offset (6 header + 16 entry)

  return Buffer.concat([header, entry, dib]);
}

/**
 * The codexskin tray glyph: 32x32 RGBA. Teal->violet gradient rounded square
 * with a white crescent, echoing the UI header logo.
 */
export function trayIconRgba(size = 32) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const r = size * 0.42;
  const cx = size / 2;
  const cy = size / 2;
  const inner = cx - r; // corner rounding inset
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      // Rounded-square mask: box distance with rounded corners.
      const dx = Math.abs(x + 0.5 - cx);
      const dy = Math.abs(y + 0.5 - cy);
      const box = Math.max(dx, dy);
      const corner = Math.hypot(Math.max(0, dx - inner), Math.max(0, dy - inner));
      if (Math.min(box, corner + inner) > r) continue;
      // Diagonal gradient #5fc6a5 (accent) -> #8b5cf6 (accent2).
      const t = (x / size + y / size) / 2;
      rgba[i] = Math.round(0x5f + (0x8b - 0x5f) * t);
      rgba[i + 1] = Math.round(0xc6 + (0x5c - 0xc6) * t);
      rgba[i + 2] = Math.round(0xa5 + (0xf6 - 0xa5) * t);
      rgba[i + 3] = 255;
    }
  }
  // White crescent: full disc minus an offset disc.
  const moonCx = cx - size * 0.06;
  const moonCy = cy - size * 0.04;
  const moonR = size * 0.24;
  const cutCx = moonCx + moonR * 0.75;
  const cutCy = moonCy + moonR * 0.62;
  const cutR = moonR * 0.88;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (rgba[i + 3] === 0) continue;
      const inMoon = Math.hypot(x + 0.5 - moonCx, y + 0.5 - moonCy) <= moonR;
      const inCut = Math.hypot(x + 0.5 - cutCx, y + 0.5 - cutCy) <= cutR;
      if (inMoon && !inCut) {
        rgba[i] = 255;
        rgba[i + 1] = 255;
        rgba[i + 2] = 255;
      }
    }
  }
  return rgba;
}

/**
 * The PowerShell tray host: a WinForms NotifyIcon app (single instance via a
 * per-user named mutex), mirroring Codex-Dream-Skin's tray-dream-skin.ps1.
 * Menu actions call the tokened loopback UI server; balloons mirror toasts.
 * A watchdog timer exits the host when its server stays unreachable, so a
 * crashed main app never leaves a zombie tray behind.
 */
export function buildTrayHostPs1({ mutex = TRAY_MUTEX } = {}) {
  return `# codexskin tray host (generated by codexskin; do not edit)
# Native desktop integration in the style of Codex-Dream-Skin's tray app:
# single instance, context menu, balloon notifications, login autostart.
param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$LogFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
${taskbarPropertySource}
'@
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CodexSkinWindowIcons { [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l); }'
$script:windowIcons = @{}
function Update-WindowIcons {
  $live = @{}
  # Brand only the control window; keep the installed ChatGPT/Codex identity.
  foreach ($name in @('chrome','msedge')) {
    foreach ($app in [Diagnostics.Process]::GetProcessesByName($name)) {
      try {
        if ($app.MainWindowTitle -ne ('codexskin ' + [char]0x2014 + ' Your theme library')) { continue }
        $handle = $app.MainWindowHandle
        if ($handle -eq [IntPtr]::Zero) { continue }
        $key = "$($app.Id):$handle"
        $live[$key] = $true
        if ($script:windowIcons.ContainsKey($key)) { continue }
        $brandPath = Join-Path $PSScriptRoot '${TRAY_ICON_NAME}'
        $image = [Drawing.Icon]::new($brandPath)
        [CodexSkinTaskbar]::Set($handle,3,$brandPath)
        [CodexSkinTaskbar]::Set($handle,4,'codexskin')
        [CodexSkinTaskbar]::Set($handle,5,'codexskin.ControlWindow')
        $oldBig = [CodexSkinWindowIcons]::SendMessage($handle,128,[IntPtr]1,$image.Handle)
        $oldSmall = [CodexSkinWindowIcons]::SendMessage($handle,128,[IntPtr]0,$image.Handle)
        $script:windowIcons[$key] = @{ Image=$image; Window=$handle; Big=$oldBig; Small=$oldSmall }
      } catch { Log ("Control window icon failed: " + $_.Exception.Message) }
    }
  }
  foreach ($name in @('ChatGPT','Codex')) {
    foreach ($app in [Diagnostics.Process]::GetProcessesByName($name)) {
      try {
        $handle = $app.MainWindowHandle
        if ($handle -eq [IntPtr]::Zero) { continue }
        $key = "$($app.Id):$handle"
        $live[$key] = $true
        if ($script:windowIcons.ContainsKey($key)) { continue }
        $executable = $app.MainModule.FileName
        [CodexSkinTaskbar]::Set($handle,2,('"' + $executable + '"'))
        [CodexSkinTaskbar]::Set($handle,3,($executable + ',0'))
        [CodexSkinTaskbar]::Set($handle,4,$app.ProcessName)
        # Only assign a package identity when the executable belongs to it.
        $normalizedPath = $executable.Replace([char]92,[char]47)
        if ($normalizedPath -match '/WindowsApps/(OpenAI[.](?:Codex|ChatGPT))_[^/]+__([a-zA-Z0-9]+)/') {
          [CodexSkinTaskbar]::Set($handle,5,($Matches[1] + '_' + $Matches[2] + '!App'))
        }
        $image = [Drawing.Icon]::ExtractAssociatedIcon($executable)
        if ($null -eq $image) { continue }
        $oldBig = [CodexSkinWindowIcons]::SendMessage($handle,128,[IntPtr]1,$image.Handle)
        $oldSmall = [CodexSkinWindowIcons]::SendMessage($handle,128,[IntPtr]0,$image.Handle)
        $script:windowIcons[$key] = @{ Image=$image; Window=$handle; Big=$oldBig; Small=$oldSmall }
      } catch { Log ("Window icon repair failed: " + $_.Exception.Message) }
    }
  }
  foreach ($key in @($script:windowIcons.Keys)) {
    if (-not $live.ContainsKey($key)) {
      $script:windowIcons[$key].Image.Dispose()
      $script:windowIcons.Remove($key)
    }
  }
}

$mutex = [System.Threading.Mutex]::new($false, '${mutex}')
$acquired = $false
try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
if (-not $acquired) { exit 0 }

$notify = $null
$icon = $null
function Log([string]$msg) {
  if ($LogFile) { try { Add-Content -LiteralPath $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format o), $msg) } catch {} }
}
function Invoke-Api([string]$route, [string]$Body) {
  try {
    if ($Body) {
      $res = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/t/{1}/{2}" -f $Port, $Token, $route) -Method Post -ContentType 'application/json' -Body $Body -TimeoutSec 180
    } else {
      $res = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/t/{1}/{2}" -f $Port, $Token, $route) -Method Post -TimeoutSec 180
    }
    return $res
  } catch {
    Log ("api {0} failed: {1}" -f $route, $_.Exception.Message)
    return $null
  }
}
function Show-Balloon([string]$text, [string]$kind = 'Info') {
  try {
    $tip = [Enum]::Parse([System.Windows.Forms.ToolTipIcon], $kind)
    $notify.ShowBalloonTip(2600, 'codexskin', $text, $tip)
  } catch {}
}

try {
  $notify = [System.Windows.Forms.NotifyIcon]::new()
  try {
    $iconPath = Join-Path $PSScriptRoot '${TRAY_ICON_NAME}'
    $icon = [System.Drawing.Icon]::new($iconPath)
    $notify.Icon = $icon
  } catch {
    $notify.Icon = [System.Drawing.SystemIcons]::Application
  }
  $notify.Text = 'codexskin'
  $notify.Visible = $true

  $menu = [System.Windows.Forms.ContextMenuStrip]::new()
  $notify.ContextMenuStrip = $menu

  $status = $menu.Items.Add('codexskin')
  $status.Enabled = $false
  [void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())

  $openwin = $menu.Items.Add('&Open control window')
  $openwin.add_Click({
    $r = Invoke-Api 'open-window' ''
    if ($null -ne $r -and $r.ok -and $r.url) {
      Log 'control window opened'
    }
  })

  $apply = $menu.Items.Add('&Apply / re-apply skin')
  $apply.add_Click({
    $r = Invoke-Api 'apply-active'
    if ($null -ne $r -and $r.ok) {
      $w = if ($r.windows) { $r.windows } else { 1 }
      Show-Balloon ("Skin applied in {0} window(s)." -f $w)
    } elseif ($null -ne $r -and $r.code -eq 'CODEX_RUNNING_NO_PORT') {
      # Codex runs the normal way: skinning needs a restart - ask first,
      # exactly like the reference app's -PromptRestart flow.
      $answer = [System.Windows.Forms.MessageBox]::Show(
        "Codex is running without the skin profile.\`n\`nRestart it now with the skin applied? (The app will close and reopen automatically.)",
        'codexskin',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question)
      if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
        $r2 = Invoke-Api 'apply-active' '{"restart":true}'
        if ($null -ne $r2 -and $r2.ok) {
          $w2 = if ($r2.windows) { $r2.windows } else { 1 }
          Show-Balloon ("Skin applied in {0} window(s). Codex restarted with the skin profile." -f $w2)
        } else {
          $err = if ($null -ne $r2) { $r2.error } else { 'UI server unreachable' }
          Show-Balloon ("Apply failed: {0}" -f $err) 'Warning'
        }
      }
    } else {
      $err = if ($null -ne $r) { $r.error } else { 'UI server unreachable' }
      Show-Balloon ("Apply failed: {0}" -f $err) 'Warning'
    }
  })

  $launch = $menu.Items.Add('&Launch skinned Codex')
  $launch.add_Click({
    $r = Invoke-Api 'launch-codex'
    if ($null -ne $r -and $r.ok) {
      $msg = if ($r.launched) { 'Codex started with the skin profile.' } else { 'Codex already running with the skin profile.' }
      Show-Balloon $msg
    } else {
      $err = if ($null -ne $r) { $r.error } else { 'UI server unreachable' }
      Show-Balloon ("Launch failed: {0}" -f $err) 'Warning'
    }
  })

  $restore = $menu.Items.Add('Restore &official look')
  $restore.add_Click({
    $r = Invoke-Api 'restore'
    if ($null -ne $r -and $r.ok -and $r.attempted) { Show-Balloon 'Official look restored.' }
    elseif ($null -ne $r -and $r.ok) { Show-Balloon 'Codex not running; nothing to restore.' }
    else { Show-Balloon 'Restore failed: UI server unreachable' 'Warning' }
  })

  $autostart = $menu.Items.Add('Launch at &login')
  $autostart.CheckOnClick = $true
  $autostart.add_Click({
    if ($script:suppressSync) { return }
    $verb = 'disable'
    if ($autostart.Checked) { $verb = 'enable' }
    $r = Invoke-Api ('autostart/{0}' -f $verb)
    if ($null -ne $r -and $r.ok) {
      $done = 'disabled'
      if ($autostart.Checked) { $done = 'enabled' }
      Show-Balloon ("Launch at login {0}." -f $done)
    } else {
      $err = if ($null -ne $r) { $r.error } else { 'UI server unreachable' }
      Show-Balloon ("Could not change autostart: {0}" -f $err) 'Warning'
      $autostart.Checked = -not $autostart.Checked
    }
  })

  $autorestart = $menu.Items.Add('Auto-restart Codex for the &skin')
  $autorestart.CheckOnClick = $true
  $autorestart.add_Click({
    if ($script:suppressSync) { return }
    $on = $false
    if ($autorestart.Checked) { $on = $true }
    $r = Invoke-Api 'settings/auto-restart' (("{{""enabled"":{0}}}" -f $on.ToString().ToLower()))
    if ($null -ne $r -and $r.ok) {
      $done = 'off'
      if ($on) { $done = 'on' }
      Show-Balloon ("Auto-restart turned {0}." -f $done)
    } else {
      $err = if ($null -ne $r) { $r.error } else { 'UI server unreachable' }
      Show-Balloon ("Could not change auto-restart: {0}" -f $err) 'Warning'
      $autorestart.Checked = -not $autorestart.Checked
    }
  })

  function Show-RestartConsent {
    # Same question the UI window shows; answered once, remembered forever.
    $answer = [System.Windows.Forms.MessageBox]::Show(
      "codexskin noticed Codex running without the skin profile.\`n\`nAllow codexskin to close and restart Codex with the skin applied whenever it detects a normal launch? (You will not be asked again; you can change this anytime in the menu.)",
      'codexskin',
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Question)
    $allow = $false
    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { $allow = $true }
    $r = Invoke-Api 'consent/restart' (("{{""allow"":{0}}}" -f $allow.ToString().ToLower()))
    if ($null -ne $r -and $r.ok) {
      if ($allow) { Show-Balloon 'Thanks - the skin will stay on automatically.' }
      else { Show-Balloon 'Auto-restart declined.' 'Warning' }
    }
  }

  $quit = $menu.Items.Add('&Quit codexskin')
  $quit.add_Click({
    $null = Invoke-Api 'quit'
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  })

  # Watchdog: when the UI server stays unreachable, exit - a crashed or
  # quit main app must not leave a dead tray behind.
  $script:serverFails = 0
  $watch = New-Object System.Windows.Forms.Timer
  $watch.Interval = 5000
  $watch.add_Tick({
    try {
      $null = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/t/{1}/ping" -f $Port, $Token) -TimeoutSec 3
      $script:serverFails = 0
    } catch {
      $script:serverFails = $script:serverFails + 1
      if ($script:serverFails -ge 3) {
        Log 'UI server unreachable; tray exiting'
        $notify.Visible = $false
        [System.Windows.Forms.Application]::Exit()
      }
    }
  })
  $watch.Start()

  # The tray owns HICONs for the full window lifetime. A short-lived
  # PowerShell repair leaves dangling handles when that process exits.
  $windowIconPoll = New-Object System.Windows.Forms.Timer
  $windowIconPoll.Interval = 5000
  $windowIconPoll.add_Tick({ Update-WindowIcons })
  Update-WindowIcons
  $windowIconPoll.Start()

  # State poll: keep the two checkable menu items in sync with settings
  # changed elsewhere (UI window checkboxes), without clobbering clicks.
  $script:suppressSync = $true
  $statePoll = New-Object System.Windows.Forms.Timer
  $statePoll.Interval = 8000
  $statePoll.add_Tick({
    try {
      $s = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/t/{1}/state" -f $Port, $Token) -TimeoutSec 4
      $script:suppressSync = $true
      try {
        $autostart.Checked = [bool]$s.autostartEnabled
        $autorestart.Checked = [bool]$s.autoRestartEnabled
      } finally {
        $script:suppressSync = $false
      }
    } catch {}
  })
  $statePoll.Start()

  # Consent poll: surface the watcher's restart-consent ask as a MessageBox.
  $consentPoll = New-Object System.Windows.Forms.Timer
  $consentPoll.Interval = 5000
  $consentPoll.add_Tick({
    try {
      $c = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/t/{1}/consent/restart" -f $Port, $Token) -Method Get -TimeoutSec 4
      if ($null -ne $c -and $c.ok -and $null -ne $c.pending) { Show-RestartConsent }
    } catch {}
  })
  $consentPoll.Start()

  # Double-click opens the control window (reference app behavior).
  $notify.add_DoubleClick({
    $r = Invoke-Api 'open-window' ''
    if ($null -ne $r -and $r.ok -and $r.url) {
      Log 'control window opened'
    }
  })

  Log 'tray host started'
  [System.Windows.Forms.Application]::Run([System.Windows.Forms.ApplicationContext]::new())
} finally {
  if ($null -ne $windowIconPoll) { $windowIconPoll.Stop(); $windowIconPoll.Dispose() }
  foreach ($entry in $script:windowIcons.Values) {
    # Release our handles only after removing them from the native window.
    [void][CodexSkinWindowIcons]::SendMessage($entry.Window,128,[IntPtr]1,$entry.Big)
    [void][CodexSkinWindowIcons]::SendMessage($entry.Window,128,[IntPtr]0,$entry.Small)
    $entry.Image.Dispose()
  }
  if ($null -ne $notify) { $notify.Dispose() }
  if ($null -ne $icon) { $icon.Dispose() }
  if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
  Log 'tray host stopped'
}
`;
}

/**
 * Materialize tray assets into <dataDir>/tray/: codexskin-tray.ico and
 * codexskin-tray.ps1 (the tray host). Returns the paths written.
 */
export async function writeTrayAssets({ installDir } = {}) {
  const dir = installDir ?? path.join(dataDir(), "tray");
  await fs.mkdir(dir, { recursive: true });

  const ico = Buffer.from(logoIcoBase64, 'base64');
  const iconPath = path.join(dir, TRAY_ICON_NAME);
  await fs.writeFile(iconPath, ico);

  const ps1Path = path.join(dir, TRAY_PS1_NAME);
  await fs.writeFile(ps1Path, buildTrayHostPs1(), { encoding: "utf8" });
  return { dir, iconPath, ps1Path };
}

/**
 * Start the tray host. Single-instance behavior is enforced inside the host
 * itself (per-user named mutex), so re-running this is safe.
 * Returns the child pid.
 *
 * NOTE: deliberately NOT `detached: true`. On Windows, PowerShell children
 * spawned with the detached creation flag die instantly on some machines
 * (verified live: every detached variant exited before WinForms init, every
 * plain variant survived). A non-detached child still outlives this process
 * - Windows does not kill children on parent exit - and the host's own
 * watchdog (server unreachable => exit) plus stopOrphanTrays() cover the
 * leftover cases.
 */
export async function spawnTray({ ps1Path, port, token, logFile } = {}) {
  if (!IS_WIN) throw new Error("tray host is Windows-only");
  if (!ps1Path) throw new Error("tray: ps1Path required");
  if (!token) throw new Error("tray: token required");

  const psArgs = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ps1Path,
    "-Port", String(port),
    "-Token", String(token),
  ];
  if (logFile) psArgs.push("-LogFile", String(logFile));
  const { spawn } = await import("node:child_process");
  const child = spawn("powershell.exe", psArgs, {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return { pid: child.pid ?? null, isAlive: () => child.exitCode === null && child.signalCode === null };
}

/**
 * Kill tray hosts left over from a crashed previous run (their server is
 * gone and they would hold the single-instance mutex). Returns how many
 * processes were signalled. Windows-only; no-op elsewhere.
 */
export async function stopOrphanTrays() {
  if (!IS_WIN) return 0;
  const script = buildOrphanTrayCleanupScript();
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10_000, windowsHide: true });
    return String(stdout).split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

export function buildOrphanTrayCleanupScript() {
  return [
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" |",
    "Where-Object { $_.CommandLine -match 'codexskin-tray\\.ps1' } |",
    "ForEach-Object {",
    "  $trayPid = $_.ProcessId; $line = $_.CommandLine; $alive = $false",
    "  if ($line -match '-Port\\s+(\\d+)' ) { $trayPort = $Matches[1] } else { $trayPort = $null }",
    "  if ($line -match '-Token\\s+([a-zA-Z0-9_-]+)' ) { $trayToken = $Matches[1] } else { $trayToken = $null }",
    "  if ($trayPort -and $trayToken) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $trayPort + '/t/' + $trayToken + '/ping') -TimeoutSec 2; $alive = $response.StatusCode -eq 200 } catch {} }",
    "  if (-not $alive) { Stop-Process -Id $trayPid -Force -ErrorAction SilentlyContinue; $trayPid }",
    "}",
  ].join("\n");
}

function defaultStartupDir() {
  // %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup (per-user, no admin).
  return path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
  );
}

/**
 * Build PowerShell one-liners that create/remove the Startup-folder shortcut
 * for "Launch at login" (same mechanism as the reference tray app).
 * `args` are extra command-line arguments (e.g. node + script in dev mode).
 */
export function buildStartupShortcutCmd(targetExe, { name = "codexskin", args = [] } = {}) {
  const startupDir = defaultStartupDir();
  const lnkPath = path.join(startupDir, `${name}.lnk`);
  const esc = (s) => String(s).replace(/'/g, "''");
  const argsLine = (args ?? []).map((a) => `"${String(a).replace(/"/g, "")}"`).join(" ");
  const enable = [
    "$sh = New-Object -ComObject WScript.Shell",
    `$lnk = $sh.CreateShortcut('${esc(lnkPath)}')`,
    `$lnk.TargetPath = '${esc(targetExe)}'`,
    `$lnk.Arguments = '${esc(argsLine)}'`,
    `$lnk.IconLocation = '${esc(path.join(dataDir(), 'tray', TRAY_ICON_NAME))},0'`,
    "$lnk.Description = 'codexskin desktop app (tray + skinned Codex)'",
    "$lnk.Save()",
  ].join("; ");
  const disable = `Remove-Item -LiteralPath '${esc(lnkPath)}' -Force -ErrorAction SilentlyContinue`;
  return {
    startupDir,
    lnkPath,
    enableScript: `${enable}; Write-Output ok`,
    disableScript: `${disable}; Write-Output ok`,
  };
}

/**
 * Run a startup-shortcut change (enable/disable). Returns { ok, lnkPath }.
 */
export async function setLoginAutostart({ enabled, targetExe, name, args, run: runFn } = {}) {
  const cmd = buildStartupShortcutCmd(targetExe, { name, args });
  const script = enabled ? cmd.enableScript : cmd.disableScript;
  const exec = runFn ?? (async (s) => {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", s], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error) }));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  });
  const result = await exec(script);
  const ok = result.code === 0 && String(result.stdout).includes("ok");
  return {
    ok,
    lnkPath: cmd.lnkPath,
    detail: ok ? "" : (result.stderr.trim() || `exit ${result.code}`),
  };
}

/** Does the Startup shortcut exist (i.e. is login autostart enabled)? */
export async function loginAutostartEnabled({ name = "codexskin" } = {}) {
  const cmd = buildStartupShortcutCmd(process.execPath, { name });
  try {
    await fs.access(cmd.lnkPath);
    return true;
  } catch {
    return false;
  }
}
