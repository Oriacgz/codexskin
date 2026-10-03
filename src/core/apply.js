import { customizePayload } from './customization.js';
// Shared apply orchestration, used by the CLI, the watch loop, and the desktop
// UI: validate the theme record, ensure Codex is reachable (launching with the
// guarded profile when allowed), inject the payload, verify observable state,
// and record the active theme.

import { classifyPageTargets, connectCdp, listTargets } from "./cdp.js";
import { closeCodex, isCodexReachable, isCodexRunning, launchCodex, resolvePort } from "./launch.js";
import { codexExecutable, discoverCodexApp } from "./paths.js";
import {
  buildApplyExpression,
  buildCompatibilityExpression,
  buildRestoreExpression,
  buildVerifyExpression,
} from "./payload.js";
import { loadState, updateState } from "./state.js";
import {assertDebugPortSafe} from './debug-security.js';
import {manualSchedulePause} from './schedule.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply an installed theme and verify it in the renderer.
 * Returns { themeId, themeName, port, verified: true, windows, restarted }.
 * Throws with an actionable message on any failure.
 *
 * restartRunning: when Codex is running WITHOUT the debug port (started from
 * the Start menu), close it and relaunch it with the guarded skin profile.
 * This is what the reference desktop app does on Apply; without it a running
 * normal Codex can never be skinned.
 */
export async function applyTheme(store, themeId, { autoLaunch = true, restartRunning = false, scheduled = false, log = () => {} } = {}) {
  let restarted = false;
  const themes = await store.list();
  const record = themes.find((t) => t.id === themeId);
  if (!record) throw new Error(`theme "${themeId}" is not installed`);
  if (record.broken) throw new Error(`theme "${themeId}" is broken; reinstall it (codexskin import)`);

  const port = await resolvePort();
  await assertDebugPortSafe(port,{requireListener:false,fresh:true});
  if (!(await isCodexReachable(port))) {
    if (!autoLaunch || process.env.CODEXSKIN_NO_LAUNCH === "1") {
      // CODEXSKIN_NO_LAUNCH=1 is a test/CI kill-switch: never spawn the real
      // app from automated runs.
      throw new Error(`Codex is not reachable on 127.0.0.1:${port} and auto-launch is disabled`);
    }
    const app = await discoverCodexApp();
    if (!app) {
      throw new Error("Codex desktop app not found; install Codex/ChatGPT desktop (or run tools/mock-codex.mjs for testing)");
    }
    const exe = await codexExecutable(app);
    // Codex running the normal way? Only a full restart can bring up CDP -
    // launching a second instance would just focus the existing one.
    if (restartRunning && (await isCodexRunning())) {
      log("Codex is running without the skin profile; closing it and relaunching skinned…");
      const close = await closeCodex();
      if (!close.closed) {
        throw new Error("could not close the running Codex; close it manually and try again");
      }
      await sleep(600);
      restarted = true;
    }
    await launchCodex(app, exe, port);
    log(`Codex launched (CDP on 127.0.0.1:${port})`);
  }

  const payload = customizePayload(await store.loadPayload(themeId), await loadState());

  // Apply to every skin target (main window + detached windows; the
  // transparent avatar-overlay is deliberately excluded). A single-window
  // apply "succeeds" into an invisible surface - the bug behind 'theme applied
  // but nothing shows'.
  //
  // Cold-start race: right after CDP comes up, the browser endpoint can
  // answer /json/list before the first skinnable page target registers.
  // Retry until the deadline instead of failing the whole apply (the same
  // first-paint race the reference app handles with a verify loop).
  let skinTargets = [];
  const skinDeadline = Date.now() + 20_000;
  while (skinTargets.length === 0) {
    const targets = await listTargets(port);
    skinTargets = classifyPageTargets(targets).skinTargets;
    if (skinTargets.length > 0 || Date.now() >= skinDeadline) break;
    await sleep(500);
  }
  if (skinTargets.length === 0) throw new Error("no skinable Codex window found");

  const applyExpr = buildApplyExpression(
    { ...payload.theme, dataUrl: payload.dataUrl },
    payload.css,
  );

  // Apply once to every current skin target, then SETTLE: Codex recreates its
  // main-window target around route changes/focus, so freshly spawned windows
  // right after apply would otherwise be missed. We re-scan a few times and
  // top up any target that is missing the skin.
  const skinnedIds = new Set();
  let previousIds = '';
  let finalSnapshot = [];
  for (let round = 0; round < 4; round += 1) {
    const snapshot = round === 0
      ? skinTargets
      : classifyPageTargets(await listTargets(port)).skinTargets;
    finalSnapshot = snapshot;
    for (const target of snapshot) {
      const cdp = await connectCdp(port, { target });
      try {
        if (skinnedIds.has(target.id) && (await cdp.evaluate(buildVerifyExpression(themeId, payload.theme.customizationRevision)))?.ok) continue;
        const applyResult = await cdp.evaluate(applyExpr);
        if (!applyResult?.ok) {
          throw new Error(`apply failed in ${target.url?.slice(0, 40) ?? "renderer"}: ${JSON.stringify(applyResult)}`);
        }
        // Verify observable state, not just the apply call's return value.
        const verify = await cdp.evaluate(buildVerifyExpression(themeId, payload.theme.customizationRevision));
        if (!verify?.ok) {
          throw new Error(`verification failed in ${target.url?.slice(0, 40) ?? "renderer"}: ${JSON.stringify(verify)}`);
        }
        skinnedIds.add(target.id);
      } finally {
        cdp.close();
      }
    }
    const currentIds = snapshot.map(target => target.id).sort().join(',');
    if (round > 0 && currentIds && currentIds === previousIds) break;
    previousIds = currentIds;
    if (round < 3) await sleep(400);
  }
  const results = finalSnapshot.filter(target => skinnedIds.has(target.id));
  if (results.length === 0) throw new Error('Codex windows closed before apply could finish');

  await updateState(state=>({...state,
    activeThemeId: themeId,
    appliedAt: new Date().toISOString(),
    debugPort: port,
    ...(!scheduled?{schedulePausedUntil:manualSchedulePause(state)}:{}),
  }));
  return { themeId, themeName: record.name, port, verified: true, windows: results.length, restarted };
}

/**
 * Remove the skin from the running renderer and clear the active theme.
 * Returns { removed } (node count) or { removed: 0 } when nothing was applied.
 */
export async function restoreSkin(port) {
  const targets = await listTargets(port);
  const { skinTargets } = classifyPageTargets(targets);
  let removed = 0;
  for (const target of skinTargets) {
    const cdp = await connectCdp(port, { target });
    try {
      const result = await cdp.evaluate(buildRestoreExpression());
      if (!result?.ok) throw new Error('renderer did not restore the official look');
      removed += result.removed ?? 0;
    } finally {
      cdp.close();
    }
  }
  await updateState(s=>({...s,activeThemeId:null,restoredAt:new Date().toISOString(),schedulePausedUntil:manualSchedulePause(s)}));
  return { removed };
}

export async function verifySkin(port, themeId) {
  const targets = classifyPageTargets(await listTargets(port)).skinTargets;
  const windows = [];
  for (const target of targets) {
    const cdp = await connectCdp(port, { target });
    try { windows.push({ targetId: target.id, ...await cdp.evaluate(buildVerifyExpression(themeId)) }); }
    finally { cdp.close(); }
  }
  return { ok: windows.length > 0 && windows.every(window => window.ok), themeId, windows };
}

// Inspect only: never launch, restart, or alter renderer state beyond verification.
export async function checkCompatibility(port, themeId) {
  const targets = classifyPageTargets(await listTargets(port)).skinTargets;
  const windows = [];
  for (const target of targets) {
    try {
      const cdp = await connectCdp(port, { target });
      try { windows.push({ targetId: target.id, ...await cdp.evaluate(buildCompatibilityExpression(themeId)) }); }
      finally { cdp.close(); }
    } catch { windows.push({ targetId: target.id, warnings: ['Could not inspect this window. Retry when Codex is ready.'] }); }
  }
  return { windows, warnings: windows.length ? [] : ['No connected Codex windows found. Launch skinned Codex first.'] };
}
