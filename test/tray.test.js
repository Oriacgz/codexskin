import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIco,
  buildStartupShortcutCmd,
  buildTrayHostPs1,
  trayIconRgba,
} from "../src/core/tray.js";

test("tray: trayIconRgba paints a rounded-square glyph with transparent corners", () => {
  const rgba = trayIconRgba(32);
  assert.equal(rgba.length, 32 * 32 * 4);
  // Center is opaque.
  const c = (16 * 32 + 16) * 4;
  assert.equal(rgba[c + 3], 255);
  // Exact corners are transparent (rounded mask).
  const corner = (0 * 32 + 0) * 4;
  assert.equal(rgba[corner + 3], 0);
  // Center pixel comes from the teal->violet gradient (not pure white/black).
  assert.notEqual(rgba[c], 255);
  assert.notEqual(rgba[c + 1], 255);
});

test("tray: buildIco writes a classic 32bpp DIB frame (no PNG frame)", () => {
  const size = 32;
  const rgba = trayIconRgba(size);
  const ico = buildIco(size, rgba);
  // ICONDIR: reserved 0, type 1, count 1.
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 1);
  // Entry: 32x32, 32bpp, image offset 22.
  assert.equal(ico[6], 32);
  assert.equal(ico[7], 32);
  assert.equal(ico.readUInt16LE(10), 1); // planes
  assert.equal(ico.readUInt16LE(12), 32); // bpp
  const xorStride = size * 4;
  const andStride = Math.ceil(size / 32) * 4;
  const dibSize = 40 + xorStride * size + andStride * size;
  assert.equal(ico.readUInt32LE(14), dibSize);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.equal(ico.length, 22 + dibSize);
  // BITMAPINFOHEADER: biSize 40, biHeight 2*size (XOR+AND), 1 plane, 32bpp,
  // BI_RGB compression - the shape System.Drawing.Icon loads everywhere.
  assert.equal(ico.readUInt32LE(22), 40);
  assert.equal(ico.readInt32LE(26), size);
  assert.equal(ico.readInt32LE(30), size * 2);
  assert.equal(ico.readUInt16LE(34), 1);
  assert.equal(ico.readUInt16LE(36), 32);
  assert.equal(ico.readUInt32LE(38), 0);
  // First XOR pixel = bottom-left source pixel, converted RGBA->BGRA.
  const src = ((size - 1) * size + 0) * 4;
  const dst = 22 + 40;
  assert.equal(ico[dst], rgba[src + 2]);
  assert.equal(ico[dst + 1], rgba[src + 1]);
  assert.equal(ico[dst + 2], rgba[src]);
  assert.equal(ico[dst + 3], rgba[src + 3]);
});

test("tray: buildIco validates size and buffer length", () => {
  assert.throws(() => buildIco(0, Buffer.alloc(0)), /size/);
  assert.throws(() => buildIco(300, Buffer.alloc(16 * 16 * 4)), /size/);
  assert.throws(() => buildIco(16, Buffer.alloc(12 * 12 * 4)), /mismatch/);
  assert.throws(() => buildIco(16, "nope"), /buffer required/);
});

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
