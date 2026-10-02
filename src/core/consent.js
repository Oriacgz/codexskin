// Restart consent + auto-restart preference, shared by watch mode, the UI
// server, and the tray host.
//
// Watch mode (and the desktop app's built-in watcher) can keep the skin
// applied across ANY Codex launch by restarting a normally-launched Codex
// (one without the debug port). Closing the user's app is intrusive, so it
// happens only with consent:
//
//   askRestartConsent()    - watcher records "please ask" (idempotent, TTL).
//   readRestartConsent()   - UI/tray read+clear the pending ask (frontend polls).
//   answerRestartConsent() - user's yes/no persists autoRestart=true/false.
//   autoRestartEnabled()   - persistent preference read by the watcher.
//   setAutoRestart()       - persist/clear the preference (UI checkbox).
//
// The pending ask is a one-slot registry, not a queue: a newer ask replaces
// an older one, and asks expire (TTL) so a dialog never pops up long after
// the fact. The preference lives in state.json (already 0600, per-user).

import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths.js";
import { loadState, updateState } from "./state.js";
import { withFileLock, writeJsonAtomic } from './atomic.js';

const PENDING_FILE = "consent-restart.json";
const PENDING_TTL_MS = 5 * 60 * 1000; // a dialog older than 5 min is stale

function pendingPath() {
  return path.join(dataDir(), PENDING_FILE);
}

function isFresh(record) {
  return Boolean(record) && (Date.now() - Number(record.at ?? 0)) < PENDING_TTL_MS;
}

/**
 * Watcher side: request that a frontend asks the user for restart consent.
 * Idempotent while a fresh ask is already pending. Returns { ok, pending }.
 */
export async function askRestartConsent({ reason = "watch" } = {}) {
  return withFileLock(`${pendingPath()}.lock`, async () => {
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(pendingPath(), "utf8"));
  } catch {
    // no pending ask
  }
  if (isFresh(existing) && existing.open) {
    return { ok: true, pending: true };
  }
  const record = {
    open: true,
    reason,
    at: Date.now(),
  };
  await fs.mkdir(dataDir(), { recursive: true });
  await writeJsonAtomic(pendingPath(), record);
  return { ok: true, pending: true };
  });
}

/**
 * Frontend side: read (and clear) the pending ask, if any.
 * Returns { open, reason, at } or null. The clear-on-read pattern means the
 * ask is delivered to exactly one poller - the visible UI or the tray.
 */
export async function readRestartConsent() {
  return withFileLock(`${pendingPath()}.lock`, async () => {
  try {
    const record = JSON.parse(await fs.readFile(pendingPath(), "utf8"));
    if (!record?.open || !isFresh(record)) {
      await fs.rm(pendingPath(), { force: true });
      return null;
    }
    await fs.rm(pendingPath(), { force: true });
    return { open: true, reason: record.reason ?? "watch", at: record.at };
  } catch {
    return null;
  }
  });
}

/**
 * Frontend side: deliver the user's answer. `allowed` persists the
 * auto-restart preference so the watcher never has to ask again.
 * Returns { ok, autoRestart }.
 */
export async function answerRestartConsent({ allowed }) {
  await withFileLock(`${pendingPath()}.lock`, () => fs.rm(pendingPath(), { force: true }));
  await setAutoRestart(Boolean(allowed));
  return { ok: true, autoRestart: Boolean(allowed) };
}

/**
 * Persistent preference: may the watcher restart a normally-launched Codex
 * (after asking exactly once)? Stored in state.json alongside the port and
 * active theme.
 */
export async function autoRestartEnabled() {
  const state = await loadState();
  return state.autoRestart === true;
}

export async function setAutoRestart(enabled) {
  await updateState({ autoRestart: Boolean(enabled) });
  return Boolean(enabled);
}
