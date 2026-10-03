// Platform-specific locations. One module, imported by the CLI on both OSes.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";

const APP_NAME = "codexskin";

function baseDir() {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, APP_NAME);
  }
  return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
}

export function dataDir() {
  return process.env.CODEXSKIN_HOME ?? baseDir();
}

export function themesDir() {
  return path.join(dataDir(), "themes");
}

export function statePath() {
  return path.join(dataDir(), "state.json");
}

/**
 * Trusted-keys file for signature verification of official packages.
 * Override with CODEXSKIN_TRUSTED_KEYS; default: <dataDir>/trusted-keys.pem.
 */
export function trustedKeysPath() {
  return process.env.CODEXSKIN_TRUSTED_KEYS ?? path.join(dataDir(), "trusted-keys.pem");
}

// --- Codex app discovery -------------------------------------------------

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the Codex desktop app (bundles Codex.app and the ChatGPT.app variant,
 * since recent builds ship under either name). Returns { path, kind } or null.
 */
let cachedDiscovery, discoveryExpires = 0, discoveryInFlight;
export async function discoverCodexApp() {
  if (Date.now() < discoveryExpires) return cachedDiscovery;
  if (!discoveryInFlight) discoveryInFlight = discoverCodexAppFresh().then(value => {
    cachedDiscovery = value;
    discoveryExpires = Date.now() + (value ? 30_000 : 5_000);
    return value;
  }).finally(() => { discoveryInFlight = null; });
  return discoveryInFlight;
}

async function discoverCodexAppFresh() {
  if (IS_MAC) {
    const candidates = [
      { p: "/Applications/Codex.app", kind: "codex" },
      { p: path.join(os.homedir(), "Applications/Codex.app"), kind: "codex" },
      { p: "/Applications/ChatGPT.app", kind: "chatgpt" },
      { p: path.join(os.homedir(), "Applications/ChatGPT.app"), kind: "chatgpt" },
    ];
    for (const c of candidates) {
      const bin = path.join(c.p, "Contents", "MacOS");
      if (await exists(bin)) return { path: c.p, kind: c.kind, binDir: bin };
    }
    return null;
  }

  if (IS_WIN) {
    // Preferred discovery: ask Windows directly via Get-AppxPackage (works
    // regardless of version drift or ACL-blocked directory listings). The
    // AppxManifest names the entry executable ("app/ChatGPT.exe" today).
    const msix = await discoverMsixViaManifest();
    if (msix) return msix;

    // Legacy layout seen in ChatGPT-desktop installs: a writable app copy at
    // %LOCALAPPDATA%\Packages\OpenAI.*\LocalState\app\ChatGPT.exe.
    const packagesDir = path.join(process.env.LOCALAPPDATA ?? "", "Packages");
    try {
      const pkgs = await fs.readdir(packagesDir);
      for (const name of pkgs) {
        if (!/^OpenAI\.(Codex|ChatGPT)/i.test(name)) continue;
        const exe = path.join(packagesDir, name, "LocalState", "app", "ChatGPT.exe");
        if (await exists(exe)) return { path: path.dirname(path.dirname(exe)), kind: "msix-local", exe };
      }
    } catch {
      // no Packages dir
    }
    // NSIS/Squirrel-ish fallback installs
    for (const base of [
      path.join(process.env.LOCALAPPDATA ?? "", "Programs"),
      "C:\\Program Files",
    ]) {
      for (const sub of ["Codex", "ChatGPT", "OpenAI Codex"]) {
        const exe = path.join(base, sub, "app", "ChatGPT.exe");
        if (await exists(exe)) return { path: path.dirname(path.dirname(exe)), kind: "install", exe };
      }
    }
    return null;
  }

  return null;
}

/**
 * MSIX discovery via PowerShell: Get-AppxPackage for OpenAI.Codex / ChatGPT,
 * then read AppxManifest.xml for the entry executable. The WindowsApps folder
 * itself is ACL-protected, but the manifest is readable and the package root
 * path it names is usable for launching.
 */
async function discoverMsixViaManifest() {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run("powershell", [
      "-NoProfile", "-Command",
      "Get-AppxPackage | Where-Object { $_.Name -match '^(OpenAI\\.(Codex|ChatGPT))$' } | Select-Object -ExpandProperty InstallLocation",
    ], { timeout: 15_000, windowsHide: true });
    const locations = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 3);
    for (const location of locations) {
      const exe = await executableFromManifest(location);
      if (exe) {
        return { path: location, kind: "msix", exe };
      }
    }
  } catch {
    // PowerShell unavailable or no package - fall through to other strategies.
  }
  return null;
}

async function executableFromManifest(installLocation) {
  try {
    const manifestPath = path.join(installLocation, "AppxManifest.xml");
    const xml = await fs.readFile(manifestPath, "utf8");
    // Applications/Application[@Executable] - first entry wins. The Executable
    // attribute is relative to the package root ("app/ChatGPT.exe" today).
    const match = /<Application\b[^>]*\bExecutable="([^"]+)"/.exec(xml);
    if (!match) return null;
    const exe = path.join(installLocation, ...match[1].split("/"));
    return (await exists(exe)) ? exe : null;
  } catch {
    return null;
  }
}

/**
 * Path of the main executable used for version detection.
 */
export async function codexExecutable(appInfo) {
  if (IS_WIN) return appInfo?.exe ?? null;
  if (!appInfo) return null;
  // Pick the first executable in Contents/MacOS (there is normally exactly one).
  try {
    const entries = await fs.readdir(appInfo.binDir);
    const bin = entries.find((n) => !n.endsWith("_helper"));
    return bin ? path.join(appInfo.binDir, bin) : null;
  } catch {
    return null;
  }
}
