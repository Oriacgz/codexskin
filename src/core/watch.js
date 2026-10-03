import { customizePayload } from './customization.js';
// Watch mode: keep the active theme applied.
//
// A small polling loop that, every `intervalMs`:
//  1. checks whether Codex is reachable on the debug port
//  2. verifies the active theme is live in the renderer (observable DOM state)
//  3. re-applies the payload when verification fails, relaunching Codex with
//     the guarded profile when the debug port is gone entirely
//
// Design notes:
//  - The per-tick decision (`watchTick`) is pure-ish and dependency-injected,
//    so the full decision matrix is unit-testable without a real Codex.
//  - Only state CHANGES are logged - a healthy skin produces silence, not spam.
//  - Transient CDP failures (navigation,evaluate during reload) are tolerated
//    for `toleranceTicks` before giving up on the connection.

import { classifyPageTargets, connectCdp, listTargets as listTargetsImpl } from "./cdp.js";
import { closeCodex, isCodexReachable, isCodexRunning, launchCodex, resolvePort } from "./launch.js";
import { discoverCodexApp, codexExecutable } from "./paths.js";
import { askRestartConsent as askRestartConsentImpl } from "./consent.js";
import {
  buildApplyExpression,
  buildVerifyExpression,
} from "./payload.js";
import { loadState } from "./state.js";
import {assertDebugPortSafe} from './debug-security.js';

export const WATCH_DEFAULTS = Object.freeze({
  intervalMs: 2_000,
  toleranceTicks: 3,
});

// Per-tick outcome constants (returned in the tick result as `action`).
export const WATCH_ACTIONS = Object.freeze({
  OK: "ok",                          // theme verified live, nothing done
  REAPPLIED: "reapplied",            // theme was missing/wrong; re-applied + verified
  APPLY_FAILED: "apply-failed",      // re-apply did not verify; keep watching
  RELAUNCHED: "relaunched",          // Codex was down; relaunched with profile
  RESTARTED_FOR_SKIN: "restarted-for-skin", // normal Codex closed+relaunched skinned (consented)
  WAITING_FOR_CONSENT: "waiting-for-consent", // restart allowed once user says yes
  WAITING_FOR_CODEX: "waiting-for-codex", // relaunch not attempted/failed, retry next tick
  WAITING_FOR_THEME: "waiting-for-theme", // no active theme recorded yet
  TRANSIENT: "transient",            // CDP hiccup; tolerated, retry next tick
  GAVE_UP: "gave-up",                // tolerance exceeded; loop should stop
});

function logChange(log, lastMessage, message) {
  if (message !== lastMessage) log(message);
  return message;
}

/**
 * One watch tick. All I/O is injected:
 *   deps.isReachable() -> boolean
 *   deps.launch()      -> void           (guarded relaunch; throws on failure)
 *   deps.connect()     -> { evaluate }   (CDP connection)
 *   deps.loadPayload() -> { theme: {id,...}, css }
 *   deps.log(message)  -> void           (called only on state changes)
 *   deps.now()         -> ms timestamp
 */
export async function watchTick(deps, state) {
  const {
    isReachable, launch, connect, loadPayload, log,
  } = deps;

  const payload = await loadPayload();
  if (!payload?.theme?.id) {
    state.lastMessage = logChange(log, state.lastMessage, "no active theme recorded; waiting");
    return { action: WATCH_ACTIONS.WAITING_FOR_THEME };
  }

  if (!(await isReachable())) {
    if (deps.relaunchClosed === false) {
      let running = false;
      try { running = await deps.isRunning?.() ?? false; } catch { /* Wait on uncertain process state. */ }
      if (!running) {
        state.lastMessage = logChange(log, state.lastMessage, 'Codex is closed; waiting for you to open it');
        return { action: WATCH_ACTIONS.WAITING_FOR_CODEX };
      }
    }
    if (deps.startupGraceMs > 0 && await deps.isRunning?.()) {
      const now = deps.now?.() ?? Date.now();
      state.unreachableSince ??= now;
      if (now - state.unreachableSince < deps.startupGraceMs || state.restartAttempted) {
        state.lastMessage = logChange(log, state.lastMessage, 'Codex is starting or its debug port is unavailable; waiting without restarting');
        return { action: WATCH_ACTIONS.WAITING_FOR_CODEX };
      }
    }
    // Codex is not listening on the skin port. Either it is not running at
    // all (plain guarded relaunch) or it runs the normal way (Start menu),
    // in which case skinning requires closing and relaunching it - allowed
    // only per the restart policy:
    //   "auto"  - user consented once: close + relaunch skinned
    //   "ask"   - hand the question to the UI/tray (once, via the registry)
    //   "never" - user declined / auto-launch disabled: plain relaunch only
    let policy = "never";
    try {
      policy = await deps.resolveRestartPolicy?.() ?? "never";
    } catch { policy = "never"; }
    if (policy !== "never") {
      let running = false;
      try { running = await deps.isRunning?.() ?? false; } catch { running = false; }
      if (running) {
        if (policy === "ask") {
          // Fire-and-forget: the registry is idempotent + TTL-bound, so the
          // loop keeps ticking and asks again only if still unanswered.
          void deps.askRestartConsent?.({ reason: "watch" })?.catch?.(() => {});
          state.lastMessage = logChange(
            log,
            state.lastMessage,
            "Codex is running without the skin profile; waiting for restart consent",
          );
          return { action: WATCH_ACTIONS.WAITING_FOR_CONSENT };
        }
        try {
          if (deps.startupGraceMs > 0) state.restartAttempted = true;
          await (deps.restart?.() ?? launch());
          state.lastMessage = logChange(log, state.lastMessage, "Codex restarted with the skin profile");
          return { action: WATCH_ACTIONS.RESTARTED_FOR_SKIN };
        } catch (error) {
          state.lastMessage = logChange(
            log,
            state.lastMessage,
            `waiting for Codex (${error?.message ?? error})`,
          );
          return { action: WATCH_ACTIONS.WAITING_FOR_CODEX };
        }
      }
    }
    try {
      await launch();
      state.lastMessage = logChange(log, state.lastMessage, "Codex was down; relaunched with skin profile");
      return { action: WATCH_ACTIONS.RELAUNCHED };
    } catch (error) {
      state.lastMessage = logChange(
        log,
        state.lastMessage,
        `waiting for Codex (${error?.message ?? error})`,
      );
      return { action: WATCH_ACTIONS.WAITING_FOR_CODEX };
    }
  }

  state.unreachableSince = undefined;
  state.restartAttempted = false;
  const themeId = payload.theme.id;
  const port = await deps.port();

  // Probe every skin target: main window + detached windows (overlay excluded).
  let targets;
  try {
    const all = await deps.listTargets(port);
    targets = classifyPageTargets(all).skinTargets;
  } catch (error) {
    state.transientCount += 1;
    if (state.transientCount > state.toleranceTicks) {
      state.lastMessage = logChange(log, state.lastMessage, `giving up: ${error?.message ?? error}`);
      return { action: WATCH_ACTIONS.GAVE_UP };
    }
    state.lastMessage = logChange(log, state.lastMessage, `transient CDP error: ${error?.message ?? error}`);
    return { action: WATCH_ACTIONS.TRANSIENT };
  }
  if (targets.length === 0) {
    state.lastMessage = logChange(log, state.lastMessage, "no skinable Codex window found; waiting");
    return { action: WATCH_ACTIONS.WAITING_FOR_CODEX };
  }

  let applyExpr;
  let hadTransient = false;
  let hadFailure = false;
  let reapplied = false;
  const failures = [];

  for (const target of targets) {
    let cdp;
    try {
      cdp = await connect(port, target.id);
    } catch (error) {
      hadTransient = true;
      failures.push(`${target.url?.slice(0, 30) ?? target.id.slice(0, 8)}: ${error?.message ?? error}`);
      continue;
    }
    try {
      let verify;
      try {
        verify = await cdp.evaluate(buildVerifyExpression(themeId, payload.theme.customizationRevision));
      } catch (error) {
        // Evaluate exceptions are transient (renderer mid-reload, window closing).
        hadTransient = true;
        failures.push(`${target.url?.slice(0, 30) ?? target.id.slice(0, 8)}: ${error?.message ?? error}`);
        continue;
      }
      if (verify?.ok) continue; // this window is fine
      if (deps.shouldApply && !(await deps.shouldApply(themeId))) {
        return { action: WATCH_ACTIONS.WAITING_FOR_THEME };
      }

      // Skin missing or wrong in this window: re-apply. Apply-stage failures
      // are REAL failures: the renderer answers but won't take the payload.
      reapplied = true;
      try {
        applyExpr ??= buildApplyExpression({ ...payload.theme, dataUrl: payload.dataUrl }, payload.css);
        const applyResult = await cdp.evaluate(applyExpr);
        if (!applyResult?.ok) throw new Error(`renderer returned ${JSON.stringify(applyResult)}`);
        const postVerify = await cdp.evaluate(buildVerifyExpression(themeId, payload.theme.customizationRevision));
        if (!postVerify?.ok) throw new Error(`post-apply verification failed: ${JSON.stringify(postVerify)}`);
      } catch (error) {
        hadFailure = true;
        failures.push(`${target.url?.slice(0, 30) ?? target.id.slice(0, 8)}: ${error?.message ?? error}`);
      }
    } finally {
      cdp.close?.();
    }
  }

  if (hadTransient || hadFailure) {
    if (hadTransient) state.transientCount += 1;
    if (state.transientCount > state.toleranceTicks) {
      state.lastMessage = logChange(log, state.lastMessage, `giving up: ${failures.join("; ")}`);
      return { action: WATCH_ACTIONS.GAVE_UP };
    }
    const detail = failures.join("; ") || "unknown window state";
    state.lastMessage = logChange(log, state.lastMessage, detail);
    return { action: hadFailure ? WATCH_ACTIONS.APPLY_FAILED : WATCH_ACTIONS.TRANSIENT };
  }

  state.transientCount = 0;
  const message = reapplied
    ? `theme "${themeId}" re-applied and verified in ${targets.length} window(s)`
    : `theme "${themeId}" is live in ${targets.length} window(s)`;
  state.lastMessage = logChange(log, state.lastMessage, message);
  return { action: reapplied ? WATCH_ACTIONS.REAPPLIED : WATCH_ACTIONS.OK };
}

async function sleepUntil(deps, shouldStop) {
  const interval = deps.intervalMs ?? WATCH_DEFAULTS.intervalMs;
  const deadline = Date.now() + interval;
  while (Date.now() < deadline && !shouldStop()) {
    await new Promise((r) => setTimeout(r, Math.min(100, deadline - Date.now())));
  }
}

/**
 * Real I/O deps backed by the store, launcher, and CDP client.
 */
export function createWatchDeps({ store, themeId, autoLaunch = true, restartRunning = true, relaunchClosed = true, startupGraceMs = 0, log = console.log, intervalMs } = {}) {
  let targetSnapshot = [];
  return {
    relaunchClosed,
    startupGraceMs,
    intervalMs: intervalMs ?? WATCH_DEFAULTS.intervalMs,
    async isReachable() {
      const port = await resolvePort();
      return isCodexReachable(port);
    },
    async isRunning() {
      return isCodexRunning();
    },
    async resolveRestartPolicy() {
      if (!autoLaunch || !restartRunning || process.env.CODEXSKIN_NO_LAUNCH === '1') return "never";
      const state = await loadState();
      return state.autoRestart === true ? 'auto' : state.autoRestart === false ? 'never' : 'ask';
    },
    async askRestartConsent() {
      return askRestartConsentImpl({ reason: "watch" });
    },
    async restart() {
      if (process.env.CODEXSKIN_NO_LAUNCH === '1') throw new Error('auto-launch is disabled in this environment');
      // Consented restart: close the normal Codex, relaunch with the profile.
      const app = await discoverCodexApp();
      if (!app) throw new Error("Codex app not found (run `codexskin doctor`)");
      const exe = await codexExecutable(app);
      const port = await resolvePort();
      await assertDebugPortSafe(port,{requireListener:false,fresh:true});
      if (!(await closeCodex()).closed) throw new Error('could not close the running Codex');
      await new Promise((r) => setTimeout(r, 600));
      await launchCodex(app, exe, port);
    },
    async launch() {
      if (!autoLaunch) throw new Error("auto-launch disabled (--no-launch)");
      const app = await discoverCodexApp();
      if (!app) throw new Error("Codex app not found (run `codexskin doctor`)");
      const exe = await codexExecutable(app);
      const port = await resolvePort();
      await launchCodex(app, exe, port);
    },
    async port() {
      return resolvePort();
    },
    async listTargets(port) {
      targetSnapshot = await listTargetsImpl(port);
      return targetSnapshot;
    },
    async connect(port, targetId) {
      return connectCdp(port, { targetId, target: targetSnapshot.find(target => target.id === targetId) });
    },
    async loadPayload() {
      const state = await loadState();
      if (themeId) state.activeThemeId = themeId;
      if (!state.activeThemeId) return null;
      try {
        return customizePayload(await store.loadPayload(state.activeThemeId), state);
      } catch (error) {
        throw new Error(`cannot load payload for "${state.activeThemeId}": ${error?.message ?? error}`);
      }
    },
    async shouldApply(id) {
      return themeId ? id === themeId : (await loadState()).activeThemeId === id;
    },
    log,
  };
}

/**
 * Run the watch loop until `shouldStop()` returns true or a tick reports
 * GAVE_UP. Returns the final tick result (or null if stopped externally).
 */
export async function runWatchLoop(deps, { shouldStop = () => false } = {}) {
  const state = {
    lastMessage: null,
    transientCount: 0,
    toleranceTicks: deps.toleranceTicks ?? WATCH_DEFAULTS.toleranceTicks,
  };
  let last = null;
  while (!shouldStop()) {
    let result;
    try {
      result = await watchTick(deps, state);
    } catch (error) {
      deps.log?.(`watch tick crashed: ${error?.message ?? error}`);
      state.transientCount += 1;
      result = { action: state.transientCount > state.toleranceTicks ? WATCH_ACTIONS.GAVE_UP : WATCH_ACTIONS.TRANSIENT };
    }
    last = result;
    if (result.action === WATCH_ACTIONS.GAVE_UP) break;
    await sleepUntil(deps, shouldStop);
  }
  return last;
}

/**
 * Supervised variant for service use (--keep-alive): when the inner loop gives
 * up, log, wait, and start a fresh loop instead of dying - the service manager
 * (launchd / Task Scheduler) is the outer supervisor; this is the inner one.
 * Exits only when `shouldStop` fires or the loop ends without gave-up.
 */
export async function runWatchSupervised(deps, { shouldStop = () => false, restartDelayMs = 15_000 } = {}) {
  let round = 0;
  while (!shouldStop()) {
    round += 1;
    deps.log?.(`watch session ${round} starting`);
    let result = null;
    let crashed = false;
    try {
      result = await runWatchLoop(deps, { shouldStop });
    } catch (error) {
      crashed = true;
      deps.log?.(`watch session ${round} crashed: ${error?.message ?? error}`);
    }
    if (shouldStop()) break;
    // A cleanly stopped loop (shouldStop fired mid-run) ends the supervisor.
    // A crashed or gave-up session restarts after a delay.
    if (!crashed && result?.action !== WATCH_ACTIONS.GAVE_UP) break;
    deps.log?.(`watch session ${round} ${crashed ? "crashed" : "gave up"}; restarting in ${Math.round(restartDelayMs / 1000)}s`);
    const deadline = Date.now() + restartDelayMs;
    while (Date.now() < deadline && !shouldStop()) {
      await new Promise((r) => setTimeout(r, Math.min(250, deadline - Date.now())));
    }
  }
}
