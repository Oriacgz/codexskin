import assert from "node:assert/strict";

import { test } from "node:test";
import {
  buildLaunchdPlist,
  buildTrayScript,
  buildWatchCommand,
  buildWindowsTask,
  SERVICE_LABEL,
  WINDOWS_TASK_ID,
} from "../src/core/service.js";
import { runWatchSupervised, WATCH_ACTIONS } from "../src/core/watch.js";

// --- macOS plist -------------------------------------------------------------

test("plist: contains label, watch args, RunAtLoad, KeepAlive, valid XML skeleton", () => {
  const built = buildLaunchdPlist({ themeId: "aurora-veil", intervalMs: 1500 });
  assert.ok(built.plist.includes(`<string>${SERVICE_LABEL}</string>`));
  assert.ok(built.plist.includes("--theme"));
  assert.ok(built.plist.includes("aurora-veil"));
  assert.ok(built.plist.includes("--interval"));
  assert.ok(built.plist.includes("1500"));
  assert.ok(built.plist.includes("--keep-alive"));
  assert.ok(built.plist.includes("<key>RunAtLoad</key>"));
  assert.ok(built.plist.includes("<key>KeepAlive</key>"));
  assert.ok(built.plist.includes("<key>ThrottleInterval</key>"));
  assert.ok(built.plistPath.includes("LaunchAgents"));
  assert.ok(built.plistPath.endsWith(`${SERVICE_LABEL}.plist`));
  // Balanced dict tags
  const open = (built.plist.match(/<dict>/g) ?? []).length;
  const close = (built.plist.match(/<\/dict>/g) ?? []).length;
  assert.equal(open, close);
});

test("plist: xml-escapes special characters in paths", () => {
  const built = buildLaunchdPlist({ dataDir: "/tmp/some&dir<x>" });
  assert.ok(built.plist.includes("/tmp/some&amp;dir&lt;x&gt;"));
});

test("plist: no-launch reaches the watch args", () => {
  const built = buildLaunchdPlist({ noLaunch: true });
  assert.ok(built.plist.includes("--no-launch"));
});

// --- Windows task --------------------------------------------------------------

test("windows task: files + registration args are coherent", () => {
  const task = buildWindowsTask({ themeId: "midnight-run", intervalMs: 3000 });
  assert.equal(task.taskId, WINDOWS_TASK_ID);
  const batch = task.files[task.batchPath];
  const vbs = task.files[task.vbsPath];
  assert.ok(batch.includes("codexskin-watch.cmd") === false); // sanity: not self-referential
  assert.ok(batch.includes("--theme midnight-run"));
  assert.ok(batch.includes("--interval 3000"));
  assert.ok(batch.includes("--keep-alive"));
  assert.ok(batch.includes("codexskin.mjs"));
  // Waiting keeps the scheduled task attached to the hidden watcher.
  assert.ok(vbs.includes(`sh.Run "cmd /c ""${task.batchPath}""", 0, True`));
  // Task action points at the VBS via wscript
  assert.equal(task.taskAction, `wscript.exe "${task.vbsPath}"`);
  assert.deepEqual(task.schtasksArgs.slice(0, 4), ["/Create", "/F", "/TN", WINDOWS_TASK_ID]);
  assert.ok(task.schtasksArgs.includes("ONLOGON"));
  assert.ok(task.schtasksArgs.includes("LIMITED"));
  // Log path lives in installDir
  assert.ok(task.logPath.startsWith(task.installDir));
  // Batch redirects output to the log
  assert.ok(batch.includes(`>> "${task.logPath}"`));
});

test("windows task: batch CRLF line endings", () => {
  const task = buildWindowsTask({});
  const batch = task.files[task.batchPath];
  assert.ok(batch.includes("\r\n"));
  // No bare LF: every \n must be preceded by \r.
  assert.ok(!/[^\r]\n/.test(batch));
  assert.ok(!batch.startsWith("\n"));
});

// --- tray script ----------------------------------------------------------------

test("tray script: references task id, has start/stop/quit handlers", () => {
  const tray = buildTrayScript({});
  assert.ok(tray.trayScript.includes(`$taskId = '${WINDOWS_TASK_ID}'`));
  assert.ok(tray.trayScript.includes("Stop-ScheduledTask"));
  assert.ok(tray.trayScript.includes("[System.Windows.Forms.Application]::Exit()"));
  assert.ok(tray.trayPath.endsWith("codexskin-tray.ps1"));
});

// --- watch command builder ---------------------------------------------------

test("watch command: node path, cli path, arg order", () => {
  const cmd = buildWatchCommand({ themeId: "x", intervalMs: 999 });
  assert.ok(cmd.node.endsWith(process.platform === "win32" ? "node.exe" : "node"));
  assert.equal(cmd.args[0], cmd.args[0]); // cli path is absolute; identity sanity
  assert.ok(cmd.args.includes("watch"));
  assert.ok(cmd.args.includes("--keep-alive"));
  assert.ok(path.isAbsolute(cmd.args[0]));
});

import path from "node:path";

// --- supervised loop ----------------------------------------------------------

function supervisedDeps({ failEvaluations = 0 } = {}) {
  const events = [];
  let evaluateCalls = 0;
  const deps = {
    intervalMs: 5,
    toleranceTicks: 1,
    log: (message) => events.push(message),
    async port() {
      return 9223;
    },
    async listTargets() {
      return [{ id: "t-1", type: "page", url: "app://-/index.html" }];
    },
    async isReachable() {
      return true;
    },
    async launch() {},
    async connect(_port, _targetId) {
      return {
        async evaluate() {
          evaluateCalls += 1;
          if (evaluateCalls <= failEvaluations) throw new Error("dead renderer");
          return { ok: true };
        },
        close() {},
      };
    },
    async loadPayload() {
      return {
        theme: {
          id: "t",
          name: "T",
          image: "background.png",
          appearance: "auto",
          art: { focusX: 0.5, focusY: 0.5, safeArea: "none", taskMode: "ambient", dim: 0.5, taskDim: 0.7, blur: 0 },
          colors: {},
          copy: {},
        },
        css: null,
        dataUrl: "data:image/png;base64,x",
      };
    },
  };
  return { deps, events, count: () => evaluateCalls };
}

test("supervised loop: restarts after gave-up, then healthy, then stops", async () => {
  // Two failing evaluates: tick1 transient, tick2 gave-up (tolerance 1) ->
  // session 1 ends. Session 2 starts fresh (counter resets per loop? no - it is
  // global here, so calls 3+ are healthy).
  const { deps, events } = supervisedDeps({ failEvaluations: 2 });
  let stop = false;
  setTimeout(() => {
    stop = true;
  }, 250);
  await runWatchSupervised(deps, { shouldStop: () => stop, restartDelayMs: 10 });
  assert.ok(events.some((m) => m.includes("watch session 1 starting")), events.join("|"));
  assert.ok(events.some((m) => m.includes("gave up")), events.join("|"));
  assert.ok(events.some((m) => m.includes("watch session 2 starting")), events.join("|"));
});

test("supervised loop: exits when shouldStop fires during healthy run", async () => {
  const { deps } = supervisedDeps();
  let stop = false;
  setTimeout(() => {
    stop = true;
  }, 80);
  const startedAt = Date.now();
  await runWatchSupervised(deps, { shouldStop: () => stop, restartDelayMs: 5 });
  assert.ok(Date.now() - startedAt < 2_000);
});

test("supervised loop: exception escaping the loop is caught by the supervisor", async () => {
  const { deps, events } = supervisedDeps();
  // loadPayload throwing escapes watchTick into the loop-level catch; making
  // the log sink throw on that catch-log lets the exception reach the
  // supervisor, which must log and start a new session rather than die.
  let payloadThrows = true;
  const originalPayload = deps.loadPayload;
  deps.loadPayload = async () => {
    if (payloadThrows) {
      payloadThrows = false;
      throw new Error("boom");
    }
    return originalPayload();
  };
  let rethrew = false;
  const originalLog = deps.log;
  deps.log = (message) => {
    events.push(message);
    if (!rethrew && message.includes("tick crashed")) {
      rethrew = true;
      throw new Error("escaping the loop");
    }
  };
  let stop = false;
  setTimeout(() => {
    stop = true;
  }, 200);
  await runWatchSupervised(deps, { shouldStop: () => stop, restartDelayMs: 5 });
  assert.ok(rethrew);
  assert.ok(events.some((m) => m.includes("crashed")), events.join("|"));
  assert.ok(events.some((m) => m.includes("watch session 2 starting")), events.join("|"));
});

test('service: rejects shell injection through theme and interval arguments', () => {
  for (const themeId of ['x&calc', 'x%PATH%', 'x\r\necho injected', 'x"']) {
    assert.throws(()=>buildWindowsTask({themeId}), /invalid theme id/);
  }
  assert.throws(()=>buildWatchCommand({intervalMs:'1&calc'}), /positive integer/);
  assert.throws(()=>buildWindowsTask({installDir:'C:\\unsafe%PATH%'}), /Windows command paths/);
  const task=buildWindowsTask({cliPath:'C:\\tools&stuff\\codexskin.mjs'});
  assert.ok(task.files[task.batchPath].includes('"'+path.resolve('C:\\tools&stuff\\codexskin.mjs')+'"'));
  assert.ok(task.files[task.batchPath].includes('setlocal DisableDelayedExpansion'));
  const tray=buildTrayScript({taskId:"watch'; Start-Process calc; '"});
  assert.ok(tray.trayScript.includes("$taskId = 'watch''; Start-Process calc; '''"));
});


