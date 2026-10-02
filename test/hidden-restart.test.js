import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeCodex } from '../src/core/launch.js';

for (const forced of [false, true]) {
  test(`restart hides every ${forced ? 'forced' : 'graceful'} shutdown helper`, { skip: process.platform !== 'win32' }, async () => {
    const previous = process.env.CODEXSKIN_NO_LAUNCH;
    process.env.CODEXSKIN_NO_LAUNCH = '0';
    const calls = [];
    let scans = 0;
    try {
      const result = await closeCodex({
        graceMs: forced ? 0 : 100,
        listProcesses: async () => ++scans >= (forced ? 3 : 2) ? [] : ['"Codex.exe","1234","Console","1","0 K"'],
        runCommand: async (command, args, options) => { calls.push({command,args,options}); },
      });
      assert.equal(result.closed,true);
      assert.equal(result.forced,forced);
      assert.ok(calls.length > 0);
      for (const call of calls) {
        assert.equal(call.command,'taskkill');
        assert.equal(call.options.windowsHide,true);
        assert.equal(call.args[1],'1234');
      }
      assert.equal(calls.some(call=>call.args.includes('/F')),forced);
    } finally {
      if(previous===undefined)delete process.env.CODEXSKIN_NO_LAUNCH;
      else process.env.CODEXSKIN_NO_LAUNCH=previous;
    }
  });
}
