import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { classifyPageTargets, connectCdp, listTargets } from './cdp.js';

// Explicit launch may reuse a tray-resident app. Bring its populated main page
// forward. Detached shell lifecycle belongs to Codex; never close its windows.
export async function activateCodexWindow(port, {
  targets = listTargets, connect = connectCdp, focus = focusNativeWindow,
  pause = () => new Promise(resolve => setTimeout(resolve, 1000)),
} = {}) {
  const pages = classifyPageTargets(await targets(port)).skinTargets;
  const main = pages.find(page => /^app:\/\/[^/]*\/index\.html(?:[?#]|$)/i.test(page.url ?? ''));
  if (!main) return { activated: false };
  const inspect = `({ready:document.readyState, populated:!!document.querySelector('#root')?.childElementCount, empty:!!document.querySelector('#root') && document.querySelector('#root').childElementCount===0 && !document.body.innerText.trim() && !document.querySelector('input,textarea,[contenteditable="true"]')})`;
  const mainConnection = await connect(port, {target:main});
  try {
    let populated = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await mainConnection.evaluate(inspect))?.populated) { populated = true; break; }
      await pause();
    }
    if (!populated) return {activated:false};
    await mainConnection.send('Page.bringToFront');
    await focus();
  } finally {mainConnection.close();}
  return {activated:true};
}

async function focusNativeWindow() {
  if (process.platform !== 'win32') return;
  const script = `Add-Type -AssemblyName System.Drawing; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CodexSkinFocus { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }';
  foreach ($appName in @('ChatGPT','Codex')) {
    foreach ($appProcess in [Diagnostics.Process]::GetProcessesByName($appName)) {
      $windowHandle = $appProcess.MainWindowHandle;
      if ($windowHandle -ne [IntPtr]::Zero) {
        [void][CodexSkinFocus]::ShowWindowAsync($windowHandle,9);
        [void][CodexSkinFocus]::SetForegroundWindow($windowHandle);
      }
    }
  }`;
  await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000});
}
