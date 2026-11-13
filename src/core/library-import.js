import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { dataDir } from "./paths.js";
import { writeJsonAtomic, withFileLock } from "./atomic.js";
const queuePath = () => path.join(dataDir(), "library-import.json");
export function libraryThemeId(value) {
  const url = new URL(value);
  const id = url.searchParams.get("theme");
  if (url.protocol !== "codexskin:" || url.hostname !== "import" || !["", "/"].includes(url.pathname) || url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].some(key => key !== "theme") || url.searchParams.getAll("theme").length !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || "")) throw Error("Invalid community theme link.");
  return id;
}
export function libraryProtocolArgument(args) {
  const link = args.find(value => /^codexskin:/i.test(value));
  if (!link) return null;
  if (args.length !== 1) throw Error("Community links cannot include launcher options.");
  libraryThemeId(link);
  return link;
}
export async function queueLibraryTheme(value) {
  const id = libraryThemeId(value);
  await fs.mkdir(dataDir(), { recursive: true });
  await withFileLock(queuePath()+".lock", () => writeJsonAtomic(queuePath(), { id, expiresAt: Date.now() + 300000 }));
}
export async function pendingLibraryTheme() {
  try {
    const entry = JSON.parse(await fs.readFile(queuePath(), "utf8"));
    libraryThemeId(`codexskin://import?theme=${entry.id}`);
    return entry.expiresAt > Date.now() ? entry.id : null;
  } catch { return null; }
}
export async function dismissLibraryTheme(id) {
  await withFileLock(queuePath()+".lock", async () => { if (await pendingLibraryTheme() === id) await fs.rm(queuePath(), { force: true }); });
}
export async function fetchLibraryTheme(id, fetcher = fetch) {
  libraryThemeId(`codexskin://import?theme=${id}`);
  const response = await fetcher(`https://codextheme-web-frontend.vercel.app/api/community?route=${encodeURIComponent(`themes/${id}/download`)}`, { redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw Error("Theme download failed. Download the package from the website instead.");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) { response.body.cancel?.().catch(() => {}); throw Error("Theme exceeds 32 MiB."); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function registerLibraryProtocol(executable = process.execPath) {
  if (process.platform !== "win32") return;
  const script = String.raw`$root='HKCU:\Software\Classes\codexskin'; New-Item -Path $root -Force | Out-Null; Set-Item -LiteralPath $root -Value 'URL:codexskin theme import'; New-ItemProperty -LiteralPath $root -Name 'URL Protocol' -Value '' -Force | Out-Null; New-Item -Path ($root+'\shell\open\command') -Force | Out-Null; Set-Item -LiteralPath ($root+'\shell\open\command') -Value ('"'+$env:CODEXSKIN_PROTOCOL_EXE+'" "%1"')`;
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: "ignore", env: { ...process.env, CODEXSKIN_PROTOCOL_EXE: executable } });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(Error("Community import registration failed.")));
  });
}
