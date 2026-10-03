import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStartupShortcutCmd,
  buildTrayHostPs1,
} from "../src/core/tray.js";

test("tray: buildTrayHostPs1 renders a host that wires menu actions to the tokened server", () => {
  const ps1 = buildTrayHostPs1();
  assert.ok(ps1.includes("NotifyIcon"));
  assert.ok(ps1.includes("ContextMenuStrip"));
  assert.ok(ps1.includes("ShowBalloonTip"));
  // Mutex is a single-instance guard.
  assert.match(ps1, /System\.Threading\.Mutex/);
  // Menu actions call the tokened server routes.
  assert.match(ps1, /apply-active/);
  assert.match(ps1, /launch-codex/);
  assert.match(ps1, /'restore'/);
  assert.match(ps1, /autostart/);
  assert.match(ps1, /open-window/);
  // Restart prompt on CODEX_RUNNING_NO_PORT.
  assert.match(ps1, /CODEX_RUNNING_NO_PORT/);
  assert.match(ps1, /MessageBox/);
  // Watchdog exits when the server stays unreachable (no zombie trays).
  assert.match(ps1, /serverFails/);
  assert.match(ps1, /\/ping/);
  // Quit tears down the icon and exits the message loop.
  assert.match(ps1, /Application\]::Exit/);
});

test("tray: buildStartupShortcutCmd creates enable/disable scripts with quoting", () => {
  const cmd = buildStartupShortcutCmd("C:\\Program Files\\codexskin\\codexskin-ui.exe", {
    name: "codexskin-test",
    args: ["--hidden"],
  });
  assert.match(cmd.lnkPath, /codexskin-test\.lnk$/);
  assert.match(cmd.startupDir, /Start Menu\\Programs\\Startup$/);
  assert.ok(cmd.enableScript.includes("WScript.Shell"));
  assert.ok(cmd.enableScript.includes("--hidden"));
  assert.ok(cmd.enableScript.includes("codexskin-ui.exe"));
  assert.ok(cmd.disableScript.includes("Remove-Item"));
  // Single quotes in paths are escaped PowerShell-style.
  const weird = buildStartupShortcutCmd("C:\\odd 'path\\x.exe", { name: "q" });
  assert.ok(weird.enableScript.includes("''path"));
});
