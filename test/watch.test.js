import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runWatchLoop,
  WATCH_ACTIONS,
  watchTick,
} from "../src/core/watch.js";

// Fake deps covering the full decision matrix without a real Codex.
// verify/apply are distinguished by the expression content the way the real
// payload expressions differ (verify reads getAttribute, apply does not).
function makeFakeDeps(options = {}) {
  const {
    reachable = () => true,
    launch = null,
    verify = () => ({ ok: true }),
    apply = () => ({ ok: true }),
    themeId = "my-theme",
    noPayload = false,
    running = () => false,
    restartPolicy = null, // when null, deps omit resolveRestartPolicy (=> "never")
    onAsk = null,         // when set, deps.askRestartConsent records the ask
    restart = null,       // custom restart impl; default delegates to launch
  } = options;
  const calls = { verify: 0, apply: 0, launch: 0, connect: 0, restart: 0, ask: 0 };
  const logs = [];
  const deps = {
    intervalMs: 1,
    toleranceTicks: 3,
    async port() {
      return 9223;
    },
    async isReachable() {
      return reachable();
    },
    async isRunning() {
      return running();
    },
    ...(restartPolicy
      ? { async resolveRestartPolicy() { return restartPolicy(); } }
      : {}),
    ...(onAsk
      ? { async askRestartConsent(arg) { calls.ask += 1; return onAsk(arg); } }
      : {}),
    async restart() {
      calls.restart += 1;
      if (restart) return restart();
      if (launch) { await launch(); return; }
      throw new Error("no restart configured");
    },
    async launch() {
      calls.launch += 1;
      if (launch) return launch();
      throw new Error("no launcher configured");
    },
    // watchTick now calls connect(port, targetId) once per skin target; the
    // fake listTargets returns one target so a single connect call happens.
    async listTargets() {
      return [{ id: "target-1", type: "page", url: "app://-/index.html" }];
    },
    async connect(_port, targetId) {
      calls.connect += 1;
      void targetId;
      return {
        async evaluate(expr) {
          if (expr.includes("getAttribute")) {
            calls.verify += 1;
            return verify();
          }
          calls.apply += 1;
          return apply();
        },
        close() {},
      };
    },
    async loadPayload() {
      if (noPayload) return null;
      return {
        // Realistic normalized theme shape (see store.loadPayload / normalizeTheme).
        theme: {
          id: themeId,
          name: "My Theme",
          image: "background.png",
          appearance: "auto",
          art: { focusX: 0.5, focusY: 0.5, safeArea: "none", taskMode: "ambient", dim: 0.5, taskDim: 0.7, blur: 0 },
          colors: {},
          copy: {},
        },
        css: "root { --ds-theme-surface-opacity: 0.5; }",
        dataUrl: "data:image/png;base64,xx",
      };
    },
    log(message) {
      logs.push(message);
    },
  };
  return { deps, calls, logs };
}

function freshState() {
  return { lastMessage: null, transientCount: 0, toleranceTicks: 3 };
}

test('watch: restore during a tick prevents stale payload reapplication', async () => {
  const {deps,calls}=makeFakeDeps({verify:()=>({ok:false})});
  deps.shouldApply=async()=>false;
  assert.equal((await watchTick(deps,freshState())).action,WATCH_ACTIONS.WAITING_FOR_THEME);
  assert.equal(calls.apply,0);
});

test("watch: theme verified live -> ok, no re-apply", async () => {
  const { deps, calls } = makeFakeDeps();
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.OK);
  assert.equal(calls.apply, 0);
  assert.equal(state.transientCount, 0);
});

test("watch: missing skin -> re-applied and post-verified", async () => {
  // First verify (pre-check) fails; the post-apply verify must succeed.
  let verifyCount = 0;
  const { deps, calls } = makeFakeDeps({
    verify: () => {
      verifyCount += 1;
      return verifyCount === 1 ? { ok: false, layerVisible: false } : { ok: true };
    },
    apply: () => ({ ok: true }),
  });
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.REAPPLIED);
  assert.equal(calls.apply, 1);
  assert.equal(calls.verify, 2);
});

test("watch: failed re-apply -> apply-failed, keeps watching", async () => {
  const { deps } = makeFakeDeps({
    verify: () => ({ ok: false }),
    apply: () => ({ ok: false }),
  });
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.APPLY_FAILED);
});

test("watch: relaunch when Codex is down", async () => {
  let up = false;
  const { deps, calls } = makeFakeDeps({
    reachable: () => up,
    launch: () => {
      up = true;
    },
  });
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.RELAUNCHED);
  assert.equal(calls.launch, 1);
  assert.equal(calls.connect, 0);
});

test("watch: launch failure -> waiting-for-codex", async () => {
  const { deps } = makeFakeDeps({ reachable: () => false });
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.WAITING_FOR_CODEX);
});

test("watch: normal Codex + auto policy -> consented restart", async () => {
  let up = false;
  const { deps, calls } = makeFakeDeps({
    reachable: () => up,
    running: () => !up,
    restartPolicy: () => "auto",
    restart: () => {
      up = true;
    },
    launch: () => {
      up = true;
    },
  });
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.RESTARTED_FOR_SKIN);
  assert.equal(calls.restart, 1);
  assert.equal(calls.ask, 0); // consent already granted: no asking
});

test("watch: normal Codex + ask policy -> asks once and waits", async () => {
  const { deps, calls } = makeFakeDeps({
    reachable: () => false,
    running: () => true,
    restartPolicy: () => "ask",
    onAsk: () => ({}),
  });
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.WAITING_FOR_CONSENT);
  assert.equal(calls.ask, 1);
  assert.equal(calls.restart, 0); // never touches the app without consent
  assert.equal(calls.launch, 0);
  assert.match(state.lastMessage, /waiting for restart consent/);
});

test("watch: ask policy is skipped when Codex is not running", async () => {
  let up = false;
  const { deps, calls } = makeFakeDeps({
    reachable: () => up,
    running: () => false,
    restartPolicy: () => "ask",
    onAsk: () => ({}),
    launch: () => {
      up = true;
    },
  });
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.RELAUNCHED);
  assert.equal(calls.ask, 0); // nothing to consent to: plain relaunch
});

test("watch: never policy leaves a normal Codex alone", async () => {
  const { deps, calls } = makeFakeDeps({
    reachable: () => false,
    running: () => true,
    restartPolicy: () => "never",
    onAsk: () => ({}),
    // Model the real launcher's refusal: it never closes/spawns when a
    // normal instance holds the app, it just errors.
    launch: () => {
      throw new Error("Codex is already running without the debug port.");
    },
  });
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.WAITING_FOR_CODEX);
  // The guarantees that matter: no consent ask, no forced restart.
  assert.equal(calls.ask, 0);
  assert.equal(calls.restart, 0);
  assert.match(state.lastMessage, /waiting for Codex/);
});

test("watch: restart failure -> waiting-for-codex, no crash", async () => {
  const { deps } = makeFakeDeps({
    reachable: () => false,
    running: () => true,
    restartPolicy: () => "auto",
    restart: () => {
      throw new Error("close failed");
    },
  });
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.WAITING_FOR_CODEX);
  assert.match(state.lastMessage, /close failed/);
});

test("watch: deps without policy hooks default to never (back-compat)", async () => {
  const { deps, calls } = makeFakeDeps({
    reachable: () => false,
    running: () => true,
  });
  const state = freshState();
  const result = await watchTick(deps, state);
  // Old-style fakes (no resolveRestartPolicy) behave exactly as before.
  assert.equal(result.action, WATCH_ACTIONS.WAITING_FOR_CODEX);
  assert.equal(calls.restart, 0);
});

test("watch: no active theme -> waiting-for-theme", async () => {
  const { deps } = makeFakeDeps({ noPayload: true });
  const state = freshState();
  const result = await watchTick(deps, state);
  assert.equal(result.action, WATCH_ACTIONS.WAITING_FOR_THEME);
});

test("watch: transient CDP errors tolerated then gave-up after tolerance", async () => {
  const { deps } = makeFakeDeps({
    verify: () => {
      throw new Error("websocket closed");
    },
  });
  const state = freshState();
  state.toleranceTicks = 2;
  const r1 = await watchTick(deps, state);
  const r2 = await watchTick(deps, state);
  const r3 = await watchTick(deps, state);
  assert.equal(r1.action, WATCH_ACTIONS.TRANSIENT);
  assert.equal(r2.action, WATCH_ACTIONS.TRANSIENT);
  assert.equal(r3.action, WATCH_ACTIONS.GAVE_UP);
});

test("watch: connect failure counts as transient too", async () => {
  let throwNext = true;
  const { deps } = makeFakeDeps({});
  deps.connect = async () => {
    if (throwNext) {
      throwNext = false;
      throw new Error("ECONNREFUSED");
    }
    return {
      async evaluate(expr) {
        void expr;
        return { ok: true };
      },
      close() {},
    };
  };
  const state = freshState();
  state.toleranceTicks = 2;
  const r1 = await watchTick(deps, state);
  assert.equal(r1.action, WATCH_ACTIONS.TRANSIENT);
  const r2 = await watchTick(deps, state);
  assert.equal(r2.action, WATCH_ACTIONS.OK);
});

test("watch: transient counter resets after success", async () => {
  let failing = true;
  const { deps } = makeFakeDeps({
    verify: () => {
      if (failing) throw new Error("x");
      return { ok: true };
    },
  });
  const state = freshState();
  state.toleranceTicks = 3;
  await watchTick(deps, state);
  await watchTick(deps, state);
  assert.equal(state.transientCount, 2);
  failing = false;
  await watchTick(deps, state);
  assert.equal(state.transientCount, 0);
});

test("watch: logs only on state change", async () => {
  const { deps, logs } = makeFakeDeps();
  const state = freshState();
  await watchTick(deps, state);
  await watchTick(deps, state);
  await watchTick(deps, state);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /my-theme/);
});

test("watch: runWatchLoop stops on shouldStop", async () => {
  const { deps } = makeFakeDeps();
  let ticks = 0;
  const result = await runWatchLoop(deps, {
    shouldStop: () => {
      ticks += 1;
      return ticks >= 3;
    },
  });
  assert.ok(result);
  assert.equal(result.action, WATCH_ACTIONS.OK);
  assert.ok(ticks <= 4);
});

test("watch: runWatchLoop exits on gave-up", async () => {
  const { deps } = makeFakeDeps({
    verify: () => {
      throw new Error("dead");
    },
  });
  const result = await runWatchLoop(deps, { shouldStop: () => false });
  assert.equal(result.action, WATCH_ACTIONS.GAVE_UP);
});

test('desktop watcher leaves manually closed Codex closed and resumes theming after reopen', async () => {
 let open=false;
 const {deps,calls}=makeFakeDeps({reachable:()=>open,running:()=>open,verify:()=>({ok:false}),restartPolicy:()=> 'auto'});
 deps.relaunchClosed=false;
 const state=freshState();
 for(let i=0;i<3;i++)assert.equal((await watchTick(deps,state)).action,WATCH_ACTIONS.WAITING_FOR_CODEX);
 assert.equal(calls.launch,0);assert.equal(calls.restart,0);
 open=true;
 assert.equal((await watchTick({...deps,connect:async()=>({evaluate:async expr=>expr.includes('getAttribute')?{ok:++calls.verify>1}:{ok:true},close(){}})},state)).action,WATCH_ACTIONS.REAPPLIED);
});
test('desktop watcher still supports consented restart of a running normal Codex', async()=>{
 const {deps,calls}=makeFakeDeps({reachable:()=>false,running:()=>true,restartPolicy:()=> 'auto',restart:async()=>{}});
 deps.relaunchClosed=false;
 assert.equal((await watchTick(deps,freshState())).action,WATCH_ACTIONS.RESTARTED_FOR_SKIN);
 assert.equal(calls.restart,1);
});

test('desktop startup grace prevents watcher restart races and repeated automatic restarts',async()=>{
 let clock=0;
 const {deps,calls}=makeFakeDeps({reachable:()=>false,running:()=>true,restartPolicy:()=> 'auto',restart:async()=>{}});
 deps.relaunchClosed=false;deps.startupGraceMs=60000;deps.now=()=>clock;
 const state={transientCount:0,toleranceTicks:3};
 await watchTick(deps,state);clock=30000;await watchTick(deps,state);
 assert.equal(calls.restart,0);
 clock=60001;await watchTick(deps,state);assert.equal(calls.restart,1);
 clock=120001;await watchTick(deps,state);assert.equal(calls.restart,1);
});

