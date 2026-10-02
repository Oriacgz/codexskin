import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markWindowsGui } from '../tools/windows-gui.js';
test('GUI subsystem patch supports PE32 and PE32+ and preserves all other bytes', () => {
  for (const magic of [0x10b, 0x20b]) {
    const bytes = Buffer.alloc(512);
    bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 0x3c);
    bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(240, 148);
    bytes.writeUInt16LE(magic, 152); bytes.writeUInt16LE(3, 220);
    const expected = Buffer.from(bytes); expected.writeUInt16LE(2, 220);
    assert.deepEqual(markWindowsGui(bytes), expected);
  }
});
test('GUI subsystem patch rejects malformed executables', () => {
  assert.throws(() => markWindowsGui(Buffer.alloc(5)));
  const bytes = Buffer.alloc(64); bytes.writeUInt16LE(0x5a4d,0);bytes.writeUInt32LE(0xffffffff,0x3c);
  assert.throws(() => markWindowsGui(bytes));
});

test('manager app-mode browser is visible while command helpers remain hidden',async()=>{
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('../bin/codexskin-ui.mjs',import.meta.url),'utf8');
 assert.match(source,/--window-size=1120,860'\], \{ detached: true, stdio: 'ignore', windowsHide: false \}/);
 assert.match(source,/spawn\('cmd',[^\n]+windowsHide: true/);
});
